#!/usr/bin/env python3
import socket
import sys
import threading


def pipe(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (source, target):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass


def handle(client, target_host, target_port):
    try:
        upstream = socket.create_connection((target_host, target_port), timeout=10)
    except OSError:
        client.close()
        return

    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


def main():
    if len(sys.argv) != 4:
        print("Usage: wsl-cdp-proxy.py <listen-port> <target-host> <target-port>", file=sys.stderr)
        return 2

    listen_port = int(sys.argv[1])
    target_host = sys.argv[2]
    target_port = int(sys.argv[3])

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", listen_port))
    server.listen(64)
    print(f"Proxying 127.0.0.1:{listen_port} -> {target_host}:{target_port}", flush=True)

    while True:
        client, _addr = server.accept()
        threading.Thread(target=handle, args=(client, target_host, target_port), daemon=True).start()


if __name__ == "__main__":
    raise SystemExit(main())
