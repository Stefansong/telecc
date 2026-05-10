#!/bin/bash

# Complete end-to-end test script

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

echo "🧪 urocc - Complete End-to-End Test"
echo "======================================"

# 1. Check service status
echo "📋 1. Check service status"
echo -n "   ngrok service: "
if pgrep -f "ngrok http" > /dev/null; then
    echo "✅ Running"
    NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | jq -r '.tunnels[0].public_url' 2>/dev/null || echo "Failed to retrieve")
    echo "   ngrok URL: $NGROK_URL"
else
    echo "❌ Not running"
fi

echo -n "   Telegram webhook: "
if pgrep -f "start-telegram-webhook" > /dev/null; then
    echo "✅ Running"
else
    echo "❌ Not running"
fi

# 2. Check config files
echo ""
echo "📋 2. Check config files"
echo -n "   ~/.claude/settings.json: "
if [ -f ~/.claude/settings.json ]; then
    echo "✅ Exists"
    echo "   Hooks config:"
    cat ~/.claude/settings.json | jq '.hooks' 2>/dev/null || echo "   Failed to parse"
else
    echo "❌ Not found"
fi

echo -n "   .env file: "
if [ -f .env ]; then
    echo "✅ Exists"
    echo "   Telegram config:"
    grep "TELEGRAM_" .env | grep -v "BOT_TOKEN" | while read line; do
        echo "   $line"
    done
else
    echo "❌ Not found"
fi

# 3. Test hook script
echo ""
echo "📋 3. Test hook script execution"
echo "   Running: node claude-hook-notify.js completed"
node claude-hook-notify.js completed

# 4. Check latest session
echo ""
echo "📋 4. Check latest session"
if [ -d "src/data/sessions" ]; then
    LATEST_SESSION=$(ls -t src/data/sessions/*.json 2>/dev/null | head -1)
    if [ -n "$LATEST_SESSION" ]; then
        echo "   Latest session: $(basename "$LATEST_SESSION")"
        echo "   Summary:"
        cat "$LATEST_SESSION" | jq -r '"\tToken: \(.token)\n\tType: \(.type)\n\tCreated: \(.created)\n\tTmux Session: \(.tmuxSession)"' 2>/dev/null || echo "   Failed to parse"
    else
        echo "   ❌ No session files found"
    fi
else
    echo "   ❌ Sessions directory does not exist"
fi

# 5. Test Telegram Bot connection
echo ""
echo "📋 5. Test Telegram Bot connection"
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    echo "   Sending test message to personal chat..."
    RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
        -H "Content-Type: application/json" \
        -d "{\"chat_id\": $TELEGRAM_CHAT_ID, \"text\": \"🧪 End-to-end test complete\\n\\nTime: $(date)\\n\\nIf you see this message, basic communication is working.\\n\\nNext step: Complete a task in Claude and check if you receive an automatic notification.\"}")

    if echo "$RESPONSE" | grep -q '"ok":true'; then
        echo "   ✅ Test message sent successfully"
    else
        echo "   ❌ Test message failed"
        echo "   Response: $RESPONSE"
    fi
else
    echo "   ⚠️  Telegram config incomplete"
fi

# 6. Check tmux sessions
echo ""
echo "📋 6. Check tmux sessions"
if command -v tmux >/dev/null 2>&1; then
    echo "   Current tmux sessions:"
    tmux list-sessions 2>/dev/null || echo "   No active sessions"
else
    echo "   ❌ tmux not installed"
fi

echo ""
echo "🏁 Test complete"
echo ""
echo "💡 Next debugging steps:"
echo "1. Confirm you received the Telegram test message above"
echo "2. Run Claude in a tmux session and complete a simple task"
echo "3. Check if you received an automatic notification"
echo "4. If not, check Claude output for error messages"
echo ""
echo "🔧 If issues persist, run:"
echo "   tmux new-session -s claude-debug"
echo "   # In the new session:"
echo "   export CLAUDE_HOOKS_CONFIG=$PROJECT_DIR/claude-hooks.json"
echo "   claude"
echo "   # Then try a simple task"
