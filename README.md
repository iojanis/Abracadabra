# 🎩 Abracadabra Server

A document collaboration server built on Deno with real-time editing and hierarchical permissions.

## What it does

- Multi-user document editing with Yjs/Hocuspocus
- Hierarchical document organization with path-based permissions
- File uploads with local or S3 storage
- Server-side JavaScript execution in sandboxed environment
- REST API with OpenAPI documentation
- User authentication and session management

## Requirements

- Deno 1.40.2+

## Quick start

```bash
git clone <repository-url>
cd abracadabra-server
deno task dev
```

Server runs on http://localhost:8787

## Configuration

Copy `.env.example` to `.env` and configure:

```
ABRACADABRA_PORT=8787
JWT_SECRET=change-this-in-production
SESSION_TIMEOUT=2592000
KV_DATA_PATH=./data/kv
MAX_FILE_SIZE=10485760
LOG_LEVEL=INFO
```

## API Documentation

- Swagger UI: `/api/docs/ui`
- ReDoc: `/api/docs/redoc`
- OpenAPI spec: `/api/docs/openapi.json`

## Docker

```bash
docker-compose up -d
```

## Architecture

- HTTP API layer (Hono)
- Authentication/authorization services
- Document management with Yjs state storage
- Real-time WebSocket collaboration
- Deno KV for all data storage

## Main endpoints

- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login
- `GET /api/documents/` - List documents
- `POST /api/documents/{path}` - Create document
- `GET /api/documents/{path}` - Get document
- `POST /api/uploads/` - Upload file

## Permissions

Five levels: NONE, VIEWER, COMMENTER, EDITOR, ADMIN, OWNER. Permissions inherit down document hierarchies.

## Development

```bash
deno task dev     # Start with hot reload
deno task fmt     # Format code
deno task lint    # Lint code
deno task check   # Type check
```

## License

MIT
