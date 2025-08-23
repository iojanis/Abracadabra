#!/bin/bash

# Setup Development Data for Abracadabra Server
# This script creates test users and sample documents for development

set -e  # Exit on any error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🎩 Setting up Abracadabra development data..."
echo "Root directory: $ROOT_DIR"

# Check if server is running by testing the health endpoint
check_server() {
    echo "🔍 Checking if server is running..."

    if curl -s http://localhost:8787/health > /dev/null 2>&1; then
        echo "✅ Server is running"
        return 0
    else
        echo "❌ Server is not running or not accessible at http://localhost:8787"
        echo "Please start the server first with: deno run --allow-all src/main.ts"
        return 1
    fi
}

# Run the test user creation script
setup_test_data() {
    echo "👥 Creating test users and sample documents..."

    cd "$ROOT_DIR"

    if deno run \
        --allow-net \
        --allow-env \
        --allow-read \
        --allow-write \
        scripts/create-test-users.ts; then
        echo "✅ Test data setup completed successfully!"
    else
        echo "❌ Failed to setup test data"
        return 1
    fi
}

# Main execution
main() {
    if check_server; then
        setup_test_data
        echo ""
        echo "🎉 Development environment is ready!"
        echo ""
        echo "Test Users Created:"
        echo "  👑 admin / admin123     (Administrator)"
        echo "  👤 alice / alice123     (Editor)"
        echo "  👤 bob / bob123         (Editor)"
        echo "  👤 charlie / charlie123 (User)"
        echo "  👤 demo / demo123       (User)"
        echo ""
        echo "Sample Documents:"
        echo "  📄 welcome.md           (Public welcome document)"
        echo "  📄 projects/sample-project.md"
        echo "  📄 meeting-notes/2024-01-15.md"
        echo ""
        echo "Next steps:"
        echo "  1. Open http://localhost:8787 in your browser"
        echo "  2. Sign in with any of the test users above"
        echo "  3. Start collaborating on documents!"
    else
        echo ""
        echo "To start the server, run:"
        echo "  cd $ROOT_DIR"
        echo "  deno run --allow-all src/main.ts"
        echo ""
        echo "Then run this script again to setup test data."
        exit 1
    fi
}

# Run main function
main "$@"
