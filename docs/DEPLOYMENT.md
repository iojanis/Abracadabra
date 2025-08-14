# Deployment Guide

This guide covers deployment options and configuration for the Abracadabra Server, including the new password hashing and database storage implementations.

## Password Hashing

The server now uses a **pure JavaScript password hashing implementation** built on the Web Crypto API, replacing the previous argon2 dependency that required native bindings.

### Features

- **Deno Deploy Compatible**: No FFI or WASM dependencies
- **PBKDF2-based**: Uses PBKDF2 with SHA-256 (100,000 iterations)
- **Secure**: Cryptographically secure random salts and constant-time comparison
- **Fast**: Optimized for serverless environments

### Migration from argon2

Existing passwords hashed with argon2 will need to be rehashed on next login. The system will:

1. Attempt to verify with the new password utility
2. If that fails, fall back to argon2 verification (if available)
3. Rehash the password with the new system on successful login

No immediate action is required for existing deployments.

## Key-Value Store Configuration

The server supports two KV storage backends that can be switched via environment variables:

### 1. Deno KV (Default)

**Best for**: Development, small deployments, Deno Deploy

```bash
# Use Deno KV (default)
KV_PROVIDER=deno
ABRACADABRA_KV_PATH=./data/kv.db  # Optional, defaults to ./data/kv.db
```

### 2. PostgreSQL KV

**Best for**: Production deployments, horizontal scaling, existing PostgreSQL infrastructure

```bash
# Use PostgreSQL as KV store
KV_PROVIDER=postgres
DATABASE_URL=postgresql://user:password@localhost:5432/abracadabra
# OR
POSTGRES_URL=postgresql://user:password@localhost:5432/abracadabra
```

## Environment Variables

### Core Configuration

| Variable              | Description                      | Default        | Required                  |
| --------------------- | -------------------------------- | -------------- | ------------------------- |
| `KV_PROVIDER`         | KV backend: `deno` or `postgres` | `deno`         | No                        |
| `ABRACADABRA_KV_PATH` | Path for Deno KV database        | `./data/kv.db` | No                        |
| `DATABASE_URL`        | PostgreSQL connection string     | -              | Yes (if using PostgreSQL) |
| `POSTGRES_URL`        | Alternative to DATABASE_URL      | -              | No                        |

### Server Configuration

| Variable   | Description      | Default       |
| ---------- | ---------------- | ------------- |
| `PORT`     | HTTP server port | `8000`        |
| `HOST`     | HTTP server host | `0.0.0.0`     |
| `NODE_ENV` | Environment mode | `development` |

## Deployment Platforms

### Deno Deploy

Deno Deploy is now fully supported with the removal of native dependencies.

**deno.json configuration:**

```json
{
  "tasks": {
    "start": "deno run --allow-net --allow-read --allow-write --allow-env --unstable-kv src/main.ts"
  }
}
```

**Environment setup:**

```bash
KV_PROVIDER=deno
# Deno Deploy provides managed KV automatically
```

### Traditional VPS/Cloud

For traditional deployments with PostgreSQL:

**Environment setup:**

```bash
KV_PROVIDER=postgres
DATABASE_URL=postgresql://user:password@db-host:5432/abracadabra
PORT=8000
NODE_ENV=production
```

**Docker example:**

```dockerfile
FROM denoland/deno:alpine

WORKDIR /app
COPY . .
RUN deno cache src/main.ts

EXPOSE 8000
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--unstable-kv", "src/main.ts"]
```

### Railway

Railway supports both Deno KV and PostgreSQL modes.

**For Deno KV mode:**

```bash
KV_PROVIDER=deno
ABRACADABRA_KV_PATH=/app/data/kv.db
```

**For PostgreSQL mode:**

```bash
KV_PROVIDER=postgres
DATABASE_URL=${{ Railway.POSTGRESQL_URL }}
```

## PostgreSQL Setup

When using PostgreSQL as the KV backend, the required schema is automatically created on first connection. The schema includes:

- `deno_kv` table with JSONB storage
- Proper indexes for performance
- Automatic timestamp management

### Manual Schema Creation

If you need to create the schema manually:

```sql
CREATE TABLE IF NOT EXISTS deno_kv (
    versionstamp BIGSERIAL PRIMARY KEY,
    key_path JSONB NOT NULL,
    value JSONB NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS deno_kv_key_path_idx ON deno_kv (key_path);
CREATE INDEX IF NOT EXISTS deno_kv_expires_at_idx ON deno_kv (expires_at) WHERE expires_at IS NOT NULL;

-- Auto-update timestamp trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_updated_at
BEFORE UPDATE ON deno_kv
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
```

## Performance Considerations

### Deno KV

- **Pros**: Zero setup, built-in caching, optimized for Deno
- **Cons**: Single-node only, limited scalability
- **Best for**: Development, small to medium deployments

### PostgreSQL KV

- **Pros**: Horizontal scaling, mature ecosystem, backup/restore tools
- **Cons**: Additional infrastructure, slightly higher latency
- **Best for**: Production deployments, high availability requirements

## Migration Between KV Backends

To migrate from Deno KV to PostgreSQL (or vice versa):

1. **Export data** from the current KV store
2. **Set up the new backend** with appropriate environment variables
3. **Import data** to the new KV store
4. **Update environment variables** and restart

> **Note**: Direct migration tools are not yet implemented. Contact support for assistance with large-scale migrations.

## Security Considerations

### Password Security

- Passwords are hashed with PBKDF2-SHA256 (100,000 iterations)
- Each password uses a unique cryptographically secure salt
- Constant-time comparison prevents timing attacks
- No password length limits beyond practical constraints (128 chars max)

### Database Security

- Use strong, unique PostgreSQL credentials
- Enable SSL/TLS for database connections in production
- Regularly update and patch your PostgreSQL instance
- Consider using connection pooling for high-traffic deployments

## Troubleshooting

### Common Issues

**"Failed to load native binding" error:**

- This error should no longer occur with the new pure JS implementation
- If you see this, ensure you're using the latest version

**PostgreSQL connection errors:**

- Verify `DATABASE_URL` is correctly formatted
- Check network connectivity and firewall rules
- Ensure PostgreSQL accepts connections from your deployment

**Performance issues:**

- Monitor KV operation latency
- Consider switching to PostgreSQL for better scaling
- Check database connection pool settings

### Debug Mode

Enable debug logging:

```bash
DEBUG=true
LOG_LEVEL=debug
```

## Support

For deployment issues or questions:

1. Check the [GitHub Issues](https://github.com/your-org/abracadabra-server/issues)
2. Review server logs for specific error messages
3. Test your configuration locally before deploying

---

**Last updated**: December 2024
**Version compatibility**: Abracadabra Server v1.0+
