import sys

out, ledger = sys.argv[1], sys.argv[2]
# The ledger records every invocation, so a test can see whether the engine re-ran this script.
with open(ledger, "a") as f:
    f.write("x\n")
with open(out, "w") as f:
    f.write("ok")
print('::progress {"done":1,"total":1,"unit":"stamps"}', flush=True)
