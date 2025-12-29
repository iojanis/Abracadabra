# 🎩 Abracadabra Server

A document collaboration server built on Deno with real-time editing and hierarchical permissions.

## ✨ Features

- **Real-time Collaboration:** Multi-user document editing with [Yjs](https://github.com/yjs/yjs) and [Hocuspocus](https://hocuspocus.dev/).
- **Hierarchical Documents:** Organize documents in a nested structure with path-based permissions (e.g., `/username/folder/document`).
- **Flexible Permissions:** Five-level permission system (NONE, VIEWER, COMMENTER, EDITOR, ADMIN, OWNER) with inheritance.
- **File Uploads:** Support for local and S3-based file storage.
- **REST API:** A comprehensive REST API with automatically generated OpenAPI documentation.
- **Authentication:** Secure user authentication and session management using Lucia Auth.
- **Database Support:** Works with both Deno KV and PostgreSQL.
- **Server-Side Scripting:** Execute user-defined scripts in a sandboxed environment.
- **Docker Support:** Run the server in a Docker container for easy deployment.

## 🚀 Getting Started

### Requirements

- [Deno](https://deno.land/) 1.40.2+
- [Docker](https://www.docker.com/) (for Docker deployment)

### Quick Start

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd abracadabra-server
    ```

2.  **Set up environment variables:**
    Copy the `.env.example` file to `.env` and customize the values.
    ```bash
    cp .env.example .env
    ```

3.  **Run the server:**
    ```bash
    deno task dev
    ```

The server will be running on `http://localhost:8787`.

## 🔧 Configuration

The server is configured through environment variables. See `.env.example` for a list of all available options.

### Database

The server can use either Deno KV or PostgreSQL as a database.

-   **Deno KV:** The default database for local development. The data is stored in the file specified by the `DENO_KV_PATH` environment variable.
-   **PostgreSQL:** For production deployments, it is recommended to use PostgreSQL. Set the `KV_PROVIDER` environment variable to `postgres` and provide the database connection details through the `DATABASE_URL` or `POSTGRES_URL` environment variable.

### Environment Variables

| Variable                  | Description                                                                                                | Default                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------- |
| `ABRACADABRA_PORT`        | The port the server will listen on.                                                                        | `8787`                 |
| `JWT_SECRET`              | A secret key for signing JWTs. **Change this in production.**                                              | `change-this-in-production` |
| `SESSION_TIMEOUT`         | The session timeout in seconds.                                                                            | `2592000` (30 days)    |
| `KV_PROVIDER`             | The database provider to use. Can be `deno` or `postgres`.                                                 | `deno`                 |
| `DENO_KV_PATH`            | The path to the Deno KV database file.                                                                     | `./data/abracadabra.db` |
| `DATABASE_URL`            | The connection URL for the PostgreSQL database.                                                            |                        |
| `MAX_FILE_SIZE`           | The maximum file size for uploads in bytes.                                                                | `10485760` (10MB)      |
| `LOG_LEVEL`               | The log level. Can be `DEBUG`, `INFO`, `WARN`, or `ERROR`.                                                 | `INFO`                 |
| `S3_BUCKET`               | The name of the S3 bucket for file uploads.                                                                |                        |
| `S3_REGION`               | The AWS region of the S3 bucket.                                                                           |                        |
| `S3_ACCESS_KEY_ID`        | The access key ID for the S3 bucket.                                                                       |                        |
| `S3_SECRET_ACCESS_KEY`    | The secret access key for the S3 bucket.                                                                   |                        |

## 🏗️ Architecture

-   **HTTP API Layer:** Built with [Hono](https://hono.dev/), a fast and lightweight web framework for Deno.
-   **Authentication:** [Lucia Auth](https://lucia-auth.com/) for session management and user authentication.
-   **Real-time Collaboration:** [Hocuspocus](https://hocuspocus.dev/) for WebSocket-based real-time collaboration, with [Yjs](https://github.com/yjs/yjs) for conflict-free data replication.
-   **Database:** [Deno KV](https://deno.land/api@v1.40.2?s=Deno.Kv) or [PostgreSQL](https://www.postgresql.org/) for data storage.
-   **Permissions:** A custom role-based access control (RBAC) system with hierarchical inheritance.
-   **API Documentation:** [hono-openapi](https://github.com/honojs/middleware/tree/main/packages/hono-openapi) for generating OpenAPI documentation.

##  API Documentation

The API documentation is automatically generated and available at the following endpoints:

-   **Swagger UI:** `/api/docs/ui`
-   **ReDoc:** `/api/docs/redoc`
-   **OpenAPI JSON:** `/api/docs/openapi.json`

### Main Endpoints

-   `POST /api/auth/register`: Create a new user account.
-   `POST /api/auth/login`: Log in to an existing user account.
-   `POST /api/auth/logout`: Log out from the current session.
-   `GET /api/documents`: List all documents accessible to the current user.
-   `POST /api/documents/{path}`: Create a new document at the specified path.
-   `GET /api/documents/{path}`: Retrieve a document.
-   `PUT /api/documents/{path}`: Update a document.
-   `DELETE /api/documents/{path}`: Delete a document.
-   `POST /api/uploads`: Upload a file.
-   `GET /api/uploads/{fileId}`: Retrieve file metadata.
-   `GET /api/uploads/{fileId}/download`: Download a file.

## 🔐 Permissions

The server uses a five-level permission system:

-   `NONE`: No access.
-   `VIEWER`: Can view the document.
-   `COMMENTER`: Can view and comment on the document.
-   `EDITOR`: Can view, comment on, and edit the document.
-   `ADMIN`: Can manage the document, including sharing and deleting.
-   `OWNER`: Has full control over the document.

Permissions are inherited down the document hierarchy. For example, if a user has `EDITOR` permission on `/username/folder`, they will also have `EDITOR` permission on `/username/folder/document`.

## Scripts

The project includes several scripts for development and maintenance:

-   `deno task dev`: Start the server with hot reload.
-   `deno task start`: Start the server.
-   `deno task build`: Build the server into a standalone executable.
-   `deno task check`: Type-check the code.
-   `deno task lint`: Lint the code.
-   `deno task fmt`: Format the code.
-   `deno task test`: Run the tests.

## 🐳 Docker

To run the server in a Docker container, use the following command:

```bash
docker-compose up -d
```

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.