import json, sys
total = int(sys.argv[1]) if len(sys.argv) > 1 else 3
print("starting")
for i in range(1, total + 1):
    print("::progress " + json.dumps({"done": i, "total": total, "unit": "segments"}), flush=True)
print("done", file=sys.stderr)
