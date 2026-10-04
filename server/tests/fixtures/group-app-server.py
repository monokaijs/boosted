#!/usr/bin/env python3
"""Deterministic group/child-run transport; all effects remain in temporary test directories."""
import json
import os
import sys
from pathlib import Path

home = Path(os.environ["CODEX_HOME"])
home.mkdir(parents=True, exist_ok=True)
threads = {}
calls = []
turn_id = "turn"
counter = 0
last_tool = None
pending_management = None

def emit(v):
    print(json.dumps(v), flush=True)

def next_call():
    global calls, last_tool
    if calls:
        name, arguments = calls.pop(0)
        last_tool = name
        emit({"id": 800 + len(calls), "method": "item/tool/call", "params": {
            "threadId": current_thread, "callId": name + "-" + str(len(calls)),
            "tool": name, "arguments": arguments,
        }})
    else:
        emit({"method": "turn/completed", "params": {"threadId": current_thread,
            "turn": {"id": turn_id, "status": "completed"}}})

for line in sys.stdin:
    message = json.loads(line)
    with (home / "group-rpc-log.jsonl").open("a") as log:
        log.write(json.dumps(message) + "\n")
    method = message.get("method")
    p = message.get("params", {})
    if method == "initialized":
        continue
    if method is None and "result" in message:
        if last_tool == "list_group_agents" and pending_management:
            assert message["result"]["success"]
            catalog = json.loads(message["result"]["contentItems"][0]["text"])
            extra = next(agent["id"] for agent in catalog if agent["name"] == "Extra")
            pending_management["memberIds"].append(extra)
            pending_management["memberRoles"] = {extra: {"roles": ["developer", "reviewer"]}}
            calls.insert(0, ("manage_group", pending_management))
            pending_management = None
        elif last_tool == "list_workspaces" and pending_management:
            assert message["result"]["success"]
            catalog = json.loads(message["result"]["contentItems"][0]["text"])
            pending_management["projectId"] = next(project["id"] for project in catalog if project["name"] == "Project")
            calls.insert(0, ("manage_group", pending_management))
            pending_management = None
        next_call()
        continue
    result = {}
    if method == "model/list":
        result = {"data": [{"id": "exact-alpha", "model": "exact-alpha", "isDefault": True,
                           "defaultReasoningEffort": "medium", "supportedReasoningEfforts": []}]}
    elif method == "account/rateLimits/read":
        result = {"rateLimits": {"primary": {"usedPercent": 0}}}
    elif method == "thread/start":
        counter += 1
        thread = {"id": str(os.getpid()) + "-" + str(counter), "cwd": p["cwd"],
                  "model": p.get("model", "exact-alpha"), "turns": [], "source": "appServer"}
        threads[thread["id"]] = thread
        result = {"thread": thread}
        if p.get("ephemeral"):
            assert "leader-managed" in p["baseInstructions"]
            identity_line = p["developerInstructions"].split("agentIdentity=", 1)[1].splitlines()[0]
            thread["agentIdentity"] = json.loads(identity_line)
    elif method == "thread/name/set":
        threads[p["threadId"]]["name"] = p["name"]
    elif method in ("thread/read", "thread/resume"):
        result = {"thread": threads[p["threadId"]]}
    elif method == "thread/list":
        result = {"data": list(threads.values())}
    elif method == "turn/start":
        current_thread = p["threadId"]
        raw = p["input"][0]["text"]
        try:
            prompt = json.loads(raw)
        except (ValueError, TypeError):
            prompt = None
        if not isinstance(prompt, dict) or not prompt.get("groupContext"):
            turn = {"id": "child-" + str(len(threads[current_thread]["turns"])), "status": "completed",
                    "items": [{"id": "result", "type": "agentMessage", "text": "Child verification passed"}]}
            threads[current_thread]["turns"].append(turn)
            emit({"id": message["id"], "result": {"turn": turn}})
            emit({"method": "item/completed", "params": {"threadId": current_thread, "turnId": turn["id"],
                 "item": {"id": "child-command", "type": "commandExecution", "command": "verify", "exitCode": 0}}})
            emit({"method": "turn/completed", "params": {"threadId": current_thread, "turn": turn}})
            continue
        gc = prompt["groupContext"]
        execution = gc["execution"]
        agent = execution["agentId"]
        identity = prompt["agentIdentity"]
        assert identity == threads[current_thread]["agentIdentity"]
        assert identity["agentId"] == agent
        assert identity["name"] == prompt["savedProfile"]["name"]
        assert identity["name"] == next(m["profile"]["name"] for m in gc["group"]["members"] if m["id"] == agent)
        assert gc["memberRole"] == gc["group"]["memberRoles"][agent]
        assert gc["planningAgentId"] in [m["id"] for m in gc["group"]["members"]]
        purpose = execution["purpose"]
        directive = gc["originalUserRequest"]["content"]
        thread = threads[current_thread]
        turn_id = "turn"
        emit({"id": message["id"], "result": {"turn": {"id": turn_id}}})
        assert "private-only" not in raw
        if directive == "QUOTA":
            emit({"method": "turn/completed", "params": {"threadId": current_thread,
                 "turn": {"id": turn_id, "status": "failed", "error": {"message": "Rate limit exceeded"}}}})
            continue
        has_assignment = any(task.get("rootId") == execution["rootId"] for task in gc["group"]["tasks"])
        if directive == "HOLD" and purpose != "review" and not (gc.get("assignment") or {}).get("recovery") and not (purpose == "message" and has_assignment):
            continue
        calls = []
        if purpose == "message":
            if directive == "Chào Alice":
                if agent == gc["leaderId"]:
                    alice = next(m["id"] for m in gc["group"]["members"] if m["profile"]["name"] == "Alice")
                    calls.append(("forward_group_message", {"sourceMessageId": prompt["currentUserMessages"][0]["id"], "recipientIds": [alice]}))
                    # A buffered reply after forwarding must never become a leader bubble.
                    calls.append(("send_group_message", {"content": "Unwanted leader reply"}))
                else:
                    assert identity["name"] == "Alice"
                    assert gc["currentDelivery"]["event"] == {"type": "forwarded_message", "forwardedBy": gc["leaderId"]}
                    assert prompt["currentGroupMessages"][0]["senderType"] == "user"
                    calls.append(("send_group_message", {"content": "Chào bạn, mình là Alice."}))
                next_call()
                continue
            if prompt["currentUserMessages"] and directive in ("Add Extra as developer and reviewer", "Remove Nova from the group", "Give Pock leader and designer roles", "Assign Project to this group", "Unassign the group project"):
                assert agent == gc["leaderId"]
                management = {"sourceMessageId": prompt["currentUserMessages"][0]["id"]}
                if directive.startswith("Add Extra"):
                    pending_management = {**management, "memberIds": [member["id"] for member in gc["group"]["members"]]}
                    calls.append(("list_group_agents", {}))
                elif directive.startswith("Remove Nova"):
                    management["memberIds"] = [member["id"] for member in gc["group"]["members"] if member["profile"]["name"] != "Nova"]
                    calls.append(("manage_group", management))
                elif directive.startswith("Assign Project"):
                    pending_management = management
                    calls.append(("list_workspaces", {}))
                elif directive.startswith("Unassign"):
                    management["projectId"] = None
                    calls.append(("manage_group", management))
                else:
                    management["memberRoles"] = {agent: {"roles": ["coordinator", "designer"]}}
                    calls.append(("manage_group", management))
                next_call()
                continue
            if (gc["currentDelivery"].get("event") or {}).get("type") == "task_update":
                tasks = [task for task in gc["group"]["tasks"] if task["rootId"] == execution["rootId"]]
                if tasks and all(task["status"] == "completed" for task in tasks):
                    calls.append(("send_group_message", {"content": "Team result: verified assignments completed"}))
                next_call()
                continue
            if directive in ("WORK", "CHILD") and agent == gc["planningAgentId"]:
                # The planner assigns distinct work; recipients do not each re-plan the request.
                for member in gc["group"]["members"]:
                    owner = member["id"]
                    calls.append(("create_group_task", {
                        "title": "Assignment " + owner, "instructions": directive,
                        "expectedResult": "Verified result", "ownerId": owner,
                        "fileResponsibilities": [owner + ".txt"],
                    }))
            if agent == "pock":
                peer = next(m["id"] for m in gc["group"]["members"] if m["id"] != agent)
                calls.append(("request_group_peers", {"content": "Check my approach", "recipientIds": [peer]}))
            calls.append(("send_group_message", {"content": "Ready " + agent}))
        elif purpose == "execute":
            assignment = gc["assignment"]
            child_done = any(e.get("taskId") == assignment["id"] and e.get("outcome")
                             for e in gc["group"]["executions"])
            if directive == "CHILD" and not child_done:
                calls.append(("create_chat", {
                    "title": "Child " + agent, "workingDirectory": thread["cwd"],
                    "accountId": "account", "model": "exact-alpha", "prompt": "COMPLETE",
                }))
            else:
                if directive == "WORK":
                    target = Path(thread["cwd"]) / (agent + ".txt")
                    target.write_text("Verified " + agent)
                    emit({"method": "item/completed", "params": {"threadId": current_thread, "item": {
                        "id": "file", "type": "fileChange", "status": "completed",
                        "changes": [{"path": str(target), "kind": "add"}]}}})
                calls.append(("submit_group_result", {"result": "Implemented " + agent,
                              "verification": "Read output and verified content"}))
        elif purpose == "review":
            calls.append(("review_group_task", {"revision": gc["assignment"]["revision"],
                          "decision": "approve", "evidence": "Independently verified result"}))
        next_call()
        continue
    elif method == "turn/interrupt":
        emit({"id": message["id"], "result": {}})
        emit({"method": "turn/completed", "params": {"threadId": p["threadId"],
             "turn": {"id": p["turnId"], "status": "interrupted"}}})
        continue
    emit({"id": message["id"], "result": result})
