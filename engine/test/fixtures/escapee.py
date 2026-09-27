import subprocess, sys

# A grandchild in its own session: it escapes the child's process group and inherits the child's
# stdout, so it holds the pipe open — and keeps writing to it — long after the child is gone.
subprocess.Popen(
    [sys.executable, "-u", "-c",
     "import time\nfor i in range(60):\n    print('late', i)\n    time.sleep(0.1)"],
    start_new_session=True,
)
print("one line", flush=True)
