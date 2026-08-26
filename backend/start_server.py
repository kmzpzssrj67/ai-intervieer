"""Start uvicorn with SO_REUSEADDR to handle ghost socket entries on Windows."""
import socket
import uvicorn

class ReuseAddrServer(uvicorn.Server):
    def _bind_socket(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.config.host, self.config.port))
        return sock

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, log_level="info")
