#!/usr/bin/env python3
"""Deterministic model handoffs over stdio; no inference or network access."""
import json
import os
import sys
from pathlib import Path

home = Path(os.environ["CODEX_HOME"])
thread_count = 0
turn_count = 0
call_count = 0
pending_calls = {}
scenario = "simple"
thread_id = None
turn_id = None
current_model = None
handoff_call = None


def emit(value):
    print(json.dumps(value), flush=True)


def tool(name, args, tag):
    global call_count, handoff_call
    if name == "select_agent_model":
        handoff_call = (args, tag)
    call_count += 1
    rpc_id = 700 + call_count
    pending_calls[rpc_id] = tag
    emit({"id": rpc_id, "method": "item/tool/call", "params": {
        "threadId": thread_id, "turnId": turn_id, "callId": tag,
        "tool": name, "arguments": args,
    }})


def complete(status="completed", error=None):
    emit({"method": "turn/completed", "params": {
        "threadId": thread_id,
        "turn": {"id": turn_id, "status": status, "error": error},
    }})


for line in sys.stdin:
    message = json.loads(line)
    with (home / "rpc-log.jsonl").open("a") as log:
        log.write(json.dumps(message) + "\n")
    method = message.get("method")
    params = message.get("params", {})
    if method == "initialized":
        continue
    if method == "initialize":
        emit({"id": message["id"], "result": {}})
    elif method == "model/list":
        models = [{"model": "gpt-6-luna", "isDefault": True,
                   "supportedReasoningEfforts": [{"reasoningEffort": "low"}]}]
        if scenario != "unavailable":
            models.append({"model": "gpt-6.1-sol", "supportedReasoningEfforts": [
                {"reasoningEffort": "low" if scenario == "bad-effort" else "medium"}]})
        models.append({"model": "gpt-6-astra", "supportedReasoningEfforts": [
            {"reasoningEffort": "high"}]})
        emit({"id": message["id"], "result": {"data": models}})
    elif method == "thread/start":
        thread_count += 1
        thread_id = "agent-thread-" + str(thread_count)
        assert params["model"] == "gpt-6-luna"
        assert params["allowProviderModelFallback"] is False
        assert params["config"]["model_reasoning_effort"] == "low"
        identity_line = params["developerInstructions"].split("agentIdentity=", 1)[1].splitlines()[0]
        agent_identity = json.loads(identity_line)
        emit({"id": message["id"], "result": {"thread": {"id": thread_id}}})
    elif method == "turn/start":
        turn_count += 1
        turn_id = "turn-" + str(turn_count)
        current_model = params["model"]
        assert params["threadId"] == thread_id
        assert params["approvalPolicy"] == "never"
        assert params["serviceTier"] == "default"
        emit({"id": message["id"], "result": {"turn": {"id": turn_id}}})
        if params["model"] == "gpt-6-luna":
            assert params["effort"] == "low"
            prompt = json.loads(params["input"][0]["text"])
            assert prompt["agentIdentity"] == agent_identity
            assert agent_identity["agentId"] == "pock"
            assert agent_identity["name"] == prompt["savedProfile"]["name"]
            scenario = prompt["currentUserMessages"][0]["content"]
            tool("update_profile", {"name": "Nova"}, "profile-" + turn_id)
        else:
            assert params["effort"] == ("high" if params["model"] == "gpt-6-astra" else "medium")
            if scenario == "cancel":
                emit({"method": "item/started", "params": {"threadId": thread_id, "item": {
                    "id": "command", "type": "commandExecution", "command": "long-task", "status": "inProgress"}}})
            elif scenario == "deep" and params["model"] == "gpt-6.1-sol":
                tool("select_agent_model", {"model": "gpt-6-astra", "reason": "Deep analysis"}, "deep-" + turn_id)
            elif scenario == "deep":
                tool("select_agent_model", {"model": "gpt-6.1-sol", "reason": "Attempted downgrade"}, "downgrade")
            else:
                tool("send_agent_message", {"content": "Work complete."}, "done-" + turn_id)
    elif method == "turn/interrupt":
        assert params["turnId"] == turn_id
        if scenario == "failure":
            complete("failed", {"message": "Synthetic usage limit"})
        elif scenario != "cancel" or current_model == "gpt-6-luna":
            # Simulate buffered requests racing with interruption. Duplicate replies are
            # cached, and new mutations must be rejected until the handoff completes.
            tool("select_agent_model", *handoff_call)
            tool("update_profile", {"name": "Wrong"}, "late-mutation")
            complete("interrupted")
            tool("update_profile", {"name": "Wrong"}, "stale-mutation")
        emit({"id": message["id"], "result": {}})
    elif method == "thread/backgroundTerminals/clean":
        emit({"id": message["id"], "result": {}})
    elif method is None and "result" in message:
        tag = pending_calls.pop(message["id"])
        success = message["result"]["success"]
        if tag.startswith("profile-"):
            assert success
            tool("send_agent_message", {"content": "I am checking this now."}, "ack-" + turn_id)
        elif tag.startswith("ack-"):
            assert success
            if scenario == "simple":
                complete()
            else:
                model = "gpt-5.5" if scenario == "invalid" else "gpt-6.1-sol"
                tool("select_agent_model", {"model": model, "reason": "Complex debugging"}, "select-" + turn_id)
        elif tag.startswith("select-"):
            if scenario in ("invalid", "unavailable", "bad-effort"):
                assert not success
                complete()
            else:
                assert success
        elif tag.startswith("deep-"):
            assert success
        elif tag in ("late-mutation", "stale-mutation"):
            assert not success
        elif tag == "downgrade":
            assert not success
            tool("send_agent_message", {"content": "Work complete."}, "done-" + turn_id)
        elif tag.startswith("done-"):
            assert success
            complete()
    else:
        emit({"id": message["id"], "error": {"message": "Unsupported method " + str(method)}})
