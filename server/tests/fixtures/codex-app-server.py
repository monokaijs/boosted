#!/usr/bin/env python3
"""Synthetic Codex subprocess for application lifecycle tests; never uses a network."""
import copy
import json
import os
import sys
from pathlib import Path

assert sys.argv[1:] == ["app-server", "--stdio"]
home = Path(os.environ["CODEX_HOME"])
assert home.is_absolute()
assert not any(os.environ.get(key) for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_ACCESS_TOKEN"))
threads = {}
counter = 0
run_counter = 0
pending_questions = {}
models = [
    {"id": "catalog-alpha", "model": "exact-alpha", "isDefault": True, "defaultReasoningEffort": "medium", "supportedReasoningEfforts": [{"reasoningEffort": "medium"}, {"reasoningEffort": "high"}]},
    {"id": "catalog-beta", "model": "exact-beta", "defaultReasoningEffort": "low", "supportedReasoningEfforts": [{"reasoningEffort": "low"}]},
]


def emit(message):
    print(json.dumps(message), flush=True)


def response(thread):
    path = home / "sessions" / (thread["id"] + ".json")
    path.parent.mkdir(exist_ok=True)
    thread["path"] = str(path)
    path.write_text(json.dumps(thread))
    return {"thread": copy.deepcopy(thread), "model": thread["model"], "reasoningEffort": "medium"}


for line in sys.stdin:
    message = json.loads(line)
    with (home / "rpc-log.jsonl").open("a") as log:
        log.write(json.dumps({"home": str(home), **message}) + "\n")
    method = message.get("method")
    params = message.get("params", {})
    if not method and message.get("id") in pending_questions:
        thread, turn = pending_questions.pop(message["id"])
        assert message["result"]["answers"]["approach"]["answers"]
        turn["status"] = "completed"
        response(thread)
        emit({"method": "turn/plan/updated", "params": {"threadId": thread["id"], "turnId": turn["id"], "plan": [{"step": "Implement the chosen approach and verify it", "status": "pending"}]}})
        emit({"method": "item/completed", "params": {"threadId": thread["id"], "turnId": turn["id"], "item": {"type": "plan", "text": "Use existing conventions, implement the change, and run relevant tests."}}})
        emit({"method": "turn/completed", "params": {"threadId": thread["id"], "turn": turn}})
        continue
    if method == "initialized":
        continue
    result = {}
    event = None
    try:
        if method == "initialize":
            pass
        elif method == "account/rateLimits/read":
            limits = home / "test-limits.json"
            result = json.loads(limits.read_text()) if limits.exists() else {"rateLimits": {"primary": {"usedPercent": 10}}}
            if result.get("error"):
                raise ValueError(result["error"])
        elif method == "model/list":
            result = {"data": models}
        elif method == "thread/start":
            counter += 1
            thread_id = home.name + "-thread-" + str(counter)
            threads[thread_id] = {"id": thread_id, "cwd": params["cwd"], "model": params["model"], "turns": [], "source": "appServer", "createdAt": 1700000000, "updatedAt": 1700000000}
            result = response(threads[thread_id])
        elif method == "thread/name/set":
            threads[params["threadId"]]["name"] = params["name"]
        elif method in ("thread/read", "thread/resume"):
            if params["threadId"] not in threads:
                path = Path(params.get("path") or home / "sessions" / (params["threadId"] + ".json"))
                threads[params["threadId"]] = json.loads(path.read_text())
            result = response(threads[params["threadId"]])
        elif method == "thread/list":
            result = {"data": [thread for thread in threads.values() if not thread.get("archived")]}
        elif method == "thread/loaded/list":
            result = {"data": list(threads)}
        elif method == "turn/start":
            thread = threads[params["threadId"]]
            text = params["input"][0]["text"]
            if text == "REJECT_QUOTA":
                raise ValueError("usage_limit_reached")
            if text == "REJECT_RUN":
                raise ValueError("Synthetic dispatch rejected")
            run_counter += 1
            run_id = home.name + "-run-" + str(run_counter)
            thread["model"] = params["model"]
            turn = {"id": run_id, "status": "inProgress", "items": [{"id": "user-" + run_id, "type": "userMessage", "content": params["input"]}, {"id": "reply-" + run_id, "type": "agentMessage", "text": "Synthetic coding result"}]}
            thread["turns"].append(turn)
            if text == "WITH_GOAL":
                thread["goal"] = {"status": "active", "objective": "Synthetic objective"}
            result = {"turn": turn}
            if text == "QUOTA":
                turn["status"] = "failed"
                turn["error"] = {"message": "usage_limit_reached"}
                event = {"method": "turn/completed", "params": {"threadId": thread["id"], "turn": turn}}
            response(thread)
            if text == "COMPLETE":
                turn["status"] = "completed"
                event = {"method": "turn/completed", "params": {"threadId": thread["id"], "turn": turn}}
            if params.get("collaborationMode", {}).get("mode") == "plan" and "FIXTURE_PLAN_QUESTIONS" in text:
                request_id = "question-" + run_id
                pending_questions[request_id] = (thread, turn)
                event = {"id": request_id, "method": "item/tool/requestUserInput", "params": {"threadId": thread["id"], "turnId": run_id, "questions": [{"id": "approach", "question": "Which approach should we use?", "options": [{"label": "Existing conventions", "description": "Reuse the established implementation"}]}]}}
        elif method == "turn/interrupt":
            thread = threads[params["threadId"]]
            turn = next(turn for turn in thread["turns"] if turn["id"] == params["turnId"])
            turn["status"] = "interrupted"
            event = {"method": "turn/completed", "params": {"threadId": thread["id"], "turn": turn}}
        elif method == "turn/steer":
            result = {"turnId": params["expectedTurnId"]}
        elif method == "thread/fork":
            original = threads[params["threadId"]]
            counter += 1
            thread_id = home.name + "-thread-" + str(counter)
            thread = copy.deepcopy(original)
            thread["id"] = thread_id
            thread["model"] = params.get("model") or original["model"]
            thread["forkedFromId"] = original["id"]
            if params.get("lastTurnId"):
                index = next(i for i, turn in enumerate(thread["turns"]) if turn["id"] == params["lastTurnId"])
                thread["turns"] = thread["turns"][:index + 1]
            threads[thread_id] = thread
            result = response(thread)
        elif method == "thread/delete":
            thread_id = params["threadId"]
            if any(thread.get("forkedFromId") == thread_id for thread in threads.values()):
                raise ValueError("forked history still references it")
            if threads[thread_id].get("name") == "REJECT_DELETE":
                raise ValueError("Synthetic deletion rejected")
            del threads[thread_id]
            event = {"method": "thread/deleted", "params": {"threadId": thread_id}}
        elif method == "thread/archive":
            threads[params["threadId"]]["archived"] = True
        elif method == "thread/backgroundTerminals/clean":
            pass
        elif method == "thread/goal/get":
            result = {"goal": threads[params["threadId"]].get("goal")}
        elif method == "thread/goal/set":
            threads[params["threadId"]]["goal"]["status"] = params["status"]
        else:
            raise ValueError("Unsupported method " + str(method))
        # Notifications before a response exercise buffering during RPC requests.
        if event:
            emit(event)
        emit({"id": message["id"], "result": result})
    except (KeyError, ValueError, StopIteration, OSError) as error:
        emit({"id": message["id"], "error": {"code": -32602, "message": str(error)}})
