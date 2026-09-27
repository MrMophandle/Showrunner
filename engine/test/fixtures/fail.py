import sys
print("about to fail")
print("the reason", file=sys.stderr)
sys.exit(3)
