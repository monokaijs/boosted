#!/usr/bin/env python3
"""Bounded history fixture. Any accidental full transcript RPC fails explicitly."""
import json
import os
import sys
from pathlib import Path
home = Path(os.environ['CODEX_HOME'])
def item(index):
    if index % 3 == 2:
        return {'id': f'i{index}', 'type': 'commandExecution', 'status': 'completed', 'command': 'ARGUMENT' * 1000, 'aggregatedOutput': 'OUTPUT' * 2000}
    if index % 3 == 0:
        return {'id': f'i{index}', 'type': 'userMessage', 'content': [{'type': 'text', 'text': f'Question {index}'}]}
    return {'id': f'i{index}', 'type': 'agentMessage', 'text': f'Reply {index}'}
for line in sys.stdin:
    request = json.loads(line)
    with (home / 'history-rpc.jsonl').open('a') as log:
        log.write(json.dumps(request) + '\n')
    method, params = request.get('method'), request.get('params', {})
    if method == 'initialized':
        continue
    result = {}
    if method == 'thread/read':
        if params.get('includeTurns'):
            print(json.dumps({'id': request['id'], 'error': {'code': -32602, 'message': 'Full-history read forbidden'}}), flush=True)
            continue
        result = {'thread': {'id': params['threadId'], 'cwd': '/repo', 'name': 'History', 'status': {'type': 'idle'}, 'updatedAt': 1700000000, 'turns': []}}
    elif method == 'thread/items/list':
        count = int((home / 'count').read_text()) if (home / 'count').exists() else 2000
        end = int(params['cursor']) if params.get('cursor') else count
        limit = params.get('limit', 50)
        assert 0 < limit <= 50
        start = max(0, end - limit)
        result = {'data': [{'item': item(i), 'turnId': f'turn-{i // 3}', 'startedAtMs': 1700000000000} for i in range(end-1, start-1, -1)], 'nextCursor': str(start) if start else None}
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
