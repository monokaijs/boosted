//! Serve the desktop's live frontend through the backend's public listener.
use axum::{
    Router,
    body::Body,
    extract::{FromRequestParts, Request, WebSocketUpgrade, ws::Message},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{Message as UpstreamMessage, client::IntoClientRequest};

#[derive(Clone)]
struct DevFrontend {
    url: String,
    client: reqwest::Client,
}

pub(crate) fn proxy(app: Router, url: &str) -> Router {
    let frontend = DevFrontend {
        url: url.trim_end_matches('/').into(),
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("development frontend HTTP client"),
    };
    app.fallback(move |request: Request| {
        let frontend = frontend.clone();
        async move {
            match frontend.serve(request).await {
                Ok(response) => response,
                Err(error) => {
                    tracing::warn!(%error, "development frontend unavailable");
                    (
                        StatusCode::BAD_GATEWAY,
                        "The development frontend is unavailable. Start Vite on port 5173.",
                    )
                        .into_response()
                }
            }
        }
    })
}

impl DevFrontend {
    async fn serve(
        &self,
        request: Request,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        // Retire a production PWA cache when this instance switches to live Vite assets.
        // Otherwise its old service worker can keep serving the previous UI indefinitely.
        if request.uri().path() == "/sw.js" {
            return Ok(([
                (header::CONTENT_TYPE, "text/javascript"),
                (header::CACHE_CONTROL, "no-store"),
            ], r#"self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) {
    if (key.startsWith('workbox-') && key.includes(self.registration.scope)) await caches.delete(key);
  }
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({type: 'window', includeUncontrolled: true})) {
    await client.navigate(client.url);
  }
})()));"#).into_response());
        }
        let path = request
            .uri()
            .path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/");
        let url = format!("{}{path}", self.url);
        if request
            .headers()
            .get(header::UPGRADE)
            .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
        {
            let ws_url = url.replacen("http", "ws", 1);
            let mut upstream_request = ws_url.into_client_request()?;
            if let Some(protocol) = request.headers().get(header::SEC_WEBSOCKET_PROTOCOL) {
                upstream_request
                    .headers_mut()
                    .insert(header::SEC_WEBSOCKET_PROTOCOL, protocol.clone());
            }
            let (upstream, handshake) = tokio_tungstenite::connect_async(upstream_request).await?;
            let (mut parts, _) = request.into_parts();
            let mut upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &()).await?;
            if let Some(protocol) = handshake.headers().get(header::SEC_WEBSOCKET_PROTOCOL) {
                upgrade = upgrade.protocols([protocol.to_str()?.to_owned()]);
            }
            return Ok(upgrade.on_upgrade(move |mut browser| async move {
                let mut upstream = upstream;
                loop {
                    tokio::select! {
                        message = browser.recv() => {
                            let Some(Ok(message)) = message else { break };
                            let message = match message {
                                Message::Text(text) => UpstreamMessage::Text(text.to_string().into()),
                                Message::Binary(bytes) => UpstreamMessage::Binary(bytes),
                                Message::Ping(bytes) => UpstreamMessage::Ping(bytes),
                                Message::Pong(bytes) => UpstreamMessage::Pong(bytes),
                                Message::Close(_) => { let _ = upstream.close(None).await; break; }
                            };
                            if upstream.send(message).await.is_err() { break; }
                        }
                        message = upstream.next() => {
                            let Some(Ok(message)) = message else { break };
                            let message = match message {
                                UpstreamMessage::Text(text) => Message::Text(text.to_string().into()),
                                UpstreamMessage::Binary(bytes) => Message::Binary(bytes),
                                UpstreamMessage::Ping(bytes) => Message::Ping(bytes),
                                UpstreamMessage::Pong(bytes) => Message::Pong(bytes),
                                UpstreamMessage::Close(_) => { let _ = browser.send(Message::Close(None)).await; break; }
                                UpstreamMessage::Frame(_) => continue,
                            };
                            if browser.send(message).await.is_err() { break; }
                        }
                    }
                }
            }));
        }
        // Vite sees its own host; remote browsers use only the backend URL.
        let mut headers = request.headers().clone();
        headers.remove(header::HOST);
        headers.remove(header::CONNECTION);
        let method = request.method().clone();
        let body = axum::body::to_bytes(request.into_body(), 2 * 1024 * 1024).await?;
        let upstream = self
            .client
            .request(method, url)
            .headers(headers)
            .body(body)
            .send()
            .await?;
        let status = upstream.status();
        let mut headers = upstream.headers().clone();
        headers.remove(header::TRANSFER_ENCODING);
        headers.insert(header::CACHE_CONTROL, "no-store".parse()?);
        let mut response = Response::new(Body::from(upstream.bytes().await?));
        *response.status_mut() = status;
        *response.headers_mut() = headers;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::OriginalUri, routing::get};

    async fn start(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, task)
    }

    #[tokio::test]
    async fn forwards_live_assets_and_queries_while_keeping_api_routes_local() {
        let (vite, vite_task) = start(Router::new().fallback(|uri: OriginalUri| async move {
            (
                [(header::CONTENT_TYPE, "text/javascript")],
                format!("live asset: {}", uri.0),
            )
        }))
        .await;
        let app = Router::new().route("/api/v1/health", get(|| async { "backend" }));
        let (backend, backend_task) = start(proxy(app, &vite)).await;
        let client = reqwest::Client::new();
        for path in [
            "/",
            "/src/main.tsx?t=123",
            "/@vite/client",
            "/workspace/active",
        ] {
            let response = client.get(format!("{backend}{path}")).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                response.text().await.unwrap(),
                format!("live asset: {path}")
            );
        }
        assert_eq!(
            client
                .get(format!("{backend}/api/v1/health"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "backend"
        );
        let worker = client.get(format!("{backend}/sw.js")).send().await.unwrap();
        assert_eq!(worker.headers()[header::CONTENT_TYPE], "text/javascript");
        assert!(
            worker
                .text()
                .await
                .unwrap()
                .contains("self.registration.unregister()")
        );
        vite_task.abort();
        backend_task.abort();
    }

    #[tokio::test]
    async fn proxies_hot_reload_websocket_protocol_and_messages() {
        let (vite, vite_task) = start(Router::new().fallback(
            |ws: WebSocketUpgrade, uri: OriginalUri| async move {
                assert_eq!(uri.0.query(), Some("token=123"));
                ws.protocols(["vite-hmr"])
                    .on_upgrade(|mut socket| async move {
                        while let Some(Ok(message)) = socket.recv().await {
                            if socket.send(message).await.is_err() {
                                break;
                            }
                        }
                    })
            },
        ))
        .await;
        let (backend, backend_task) = start(proxy(Router::new(), &vite)).await;
        let mut request = format!("{backend}/?token=123")
            .replacen("http", "ws", 1)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(header::SEC_WEBSOCKET_PROTOCOL, "vite-hmr".parse().unwrap());
        let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
        assert_eq!(
            response.headers()[header::SEC_WEBSOCKET_PROTOCOL],
            "vite-hmr"
        );
        for message in [
            UpstreamMessage::Text("update".into()),
            UpstreamMessage::Binary(vec![1, 2, 3].into()),
        ] {
            socket.send(message.clone()).await.unwrap();
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
                message
            );
        }
        socket.close(None).await.unwrap();
        vite_task.abort();
        backend_task.abort();
    }

    #[tokio::test]
    async fn missing_vite_does_not_silently_serve_a_stale_build() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unavailable = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (backend, task) = start(proxy(Router::new(), &unavailable)).await;
        assert_eq!(
            reqwest::get(backend).await.unwrap().status(),
            StatusCode::BAD_GATEWAY
        );
        task.abort();
    }
}
