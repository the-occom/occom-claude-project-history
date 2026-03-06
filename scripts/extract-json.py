#!/usr/bin/env python3
"""Extract first JSON object or array from stdin text (strips markdown fences)."""
import sys, json, re, os

text = sys.stdin.read()
text = re.sub(r'```json\s*', '', text)
text = re.sub(r'```\s*', '', text)
text = text.strip()

def output_and_exit(obj):
    json.dump(obj, sys.stdout)
    sys.stdout.flush()
    os._exit(0)

# Try whole text as JSON
try:
    obj = json.loads(text)
    output_and_exit(obj)
except:
    pass

# Find first JSON object (greedy)
m = re.search(r'\{[\s\S]*\}', text)
if m:
    try:
        obj = json.loads(m.group())
        output_and_exit(obj)
    except:
        pass

# Find first JSON array
m = re.search(r'\[[\s\S]*\]', text)
if m:
    try:
        obj = json.loads(m.group())
        output_and_exit(obj)
    except:
        pass
