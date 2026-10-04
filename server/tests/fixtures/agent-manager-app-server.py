#!/usr/bin/env python3
"""Exercise management turns against the separate synthetic coding subprocess."""
import json
import sys

turn_count = 0
step = 0
prompt = None
chat_id = None
pending_tool = None


def emit(value):
    print(json.dumps(value), flush=True)


def call(name, args):
    global pending_tool
    pending_tool = name
    emit({"id": 700 + step, "method": "item/tool/call", "params": {
        "threadId": "manager", "turnId": "manager-turn-" + str(turn_count),
        "callId": str(turn_count) + "-" + str(step),
        "tool": name, "arguments": args,
    }})


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    params = message.get("params", {})
    if method == "initialized":
        continue
    if method in ("initialize", "thread/backgroundTerminals/clean"):
        emit({"id": message["id"], "result": {}})
    elif method == "thread/start":
        assert params["sandbox"] == "read-only"
        assert "never implement the task yourself" in params["baseInstructions"]
        emit({"id": message["id"], "result": {"thread": {"id": "manager"}}})
    elif method == "turn/start":
        turn_count += 1
        step = 0
        prompt = json.loads(params["input"][0]["text"])
        assert params["sandboxPolicy"]["type"] == "readOnly"
        emit({"id": message["id"], "result": {"turn": {"id": "manager-turn-" + str(turn_count)}}})
        if prompt["currentUserMessages"] and prompt["currentUserMessages"][0]["content"] == "Implement":
            assert prompt["managedChats"] == []
            call("create_chat", {"workingDirectory": prompt["currentUserMessages"][1]["content"],
                 "accountId": "account", "title": "Managed task", "prompt": "COMPLETE", "model": "exact-beta"})
        elif prompt["backgroundEvents"]:
            event = prompt["backgroundEvents"][0]
            assert prompt["originalUserMessages"][0]["content"] == "Implement"
            assert "send a concrete follow-up" in event["instructions"]
            chat_id = event["chatId"]
            assert prompt["managedChats"][0]["chatId"] == chat_id
            call("read_run", {"chatId": chat_id, "runId": event["runId"]})
        else:
            assert prompt["currentUserMessages"][0]["content"] == "Refine it"
            chat_id = prompt["managedChats"][0]["chatId"]
            call("send_message", {"chatId": chat_id, "content": "COMPLETE"})
    elif method is None and "result" in message:
        assert message["result"]["success"]
        value = json.loads(message["result"]["contentItems"][0]["text"])
        step += 1
        if pending_tool == "read_run":
            assert value["status"] == "completed"
            assert value["messages"] == ["Synthetic coding result"]
            call("send_message", {"chatId": chat_id, "content": "COMPLETE"})
        elif pending_tool in ("create_chat", "send_message"):
            assert value["followUpId"]
            call("send_agent_message", {"content": "Started." if turn_count == 1 else "Continuing in the same chat."})
        else:
            emit({"method": "turn/completed", "params": {"threadId": "manager",
                  "turn": {"id": "manager-turn-" + str(turn_count), "status": "completed"}}})
