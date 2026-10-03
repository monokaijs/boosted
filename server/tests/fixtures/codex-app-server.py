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
models = [
    {"id": "catalog-alpha", "model": "exact-alpha", "isDefault": True, "defaultReasoningEffort": "medium", "supportedReasoningEfforts": [{"reasoningEffort": "medium"}, {"reasoningEffort": "high"}]},
    {"id": "catalog-beta", "model": "exact-beta", "defaultReasoningEffort": "low", "supportedReasoningEfforts": [{"reasoningEffort": "low"}]},
]


def emit(message):
    print(json.dumps(message), flush=True)


def response(thread):
    return {"thread": copy.deepcopy(thread), "model": thread["model"], "reasoningEffort": "medium"}


for line in sys.stdin:
    message = json.loads(line)
    with (home / "rpc-log.jsonl").open("a") as log:
        log.write(json.dumps({"home": str(home), **message}) + "\n")
    method = message.get("method")
    params = message.get("params", {})
    if method == "initialized":
        continue
    result = {}
    event = None
    try:
        if method == "initialize":
            pass
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
            result = response(threads[params["threadId"]])
        elif method == "thread/list":
            result = {"data": [thread for thread in threads.values() if not thread.get("archived")]}
        elif method == "thread/loaded/list":
            result = {"data": list(threads)}
        elif method == "turn/start":
            thread = threads[params["threadId"]]
            text = params["input"][0]["text"]
            if text == "REJECT_RUN":
                raise ValueError("Synthetic dispatch rejected")
            run_counter += 1
            run_id = "run-" + str(run_counter)
            thread["model"] = params["model"]
            turn = {"id": run_id, "status": "inProgress", "items": [{"id": "user-" + run_id, "type": "userMessage", "content": params["input"]}, {"id": "reply-" + run_id, "type": "agentMessage", "text": "Synthetic coding result"}]}
            thread["turns"].append(turn)
            if text == "WITH_GOAL":
                thread["goal"] = {"status": "active", "objective": "Synthetic objective"}
            result = {"turn": turn}
            if text == "COMPLETE":
                turn["status"] = "completed"
                event = {"method": "turn/completed", "params": {"threadId": thread["id"], "turn": turn}}
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
    except (KeyError, ValueError, StopIteration) as error:
        emit({"id": message["id"], "error": {"code": -32602, "message": str(error)}})
