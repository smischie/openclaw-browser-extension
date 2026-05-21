#!/bin/bash
# Publish the extension for local/self-hosted installation
# Configure these for your environment:
REMOTE_USER="your-user"
REMOTE_HOST="your-server.example.com"
REMOTE_PATH="/var/www/extension"
EXT_FILENAME="openclaw-extension.crx"

set -e

# Build .zip for store submission
echo "📦 Building extension zip..."
rm -f openclaw-extension.zip
zip -r openclaw-extension.zip . \
  -x "*.git*" \
  -x "node_modules/*" \
  -x "publish.sh" \
  -x "*.md" \
  -x "openclaw-extension.zip"

echo "✅ Created openclaw-extension.zip"

# Optional: deploy to self-hosted server for .crx distribution
# Uncomment and configure the lines below:
#
# echo "🚀 Deploying to ${REMOTE_HOST}..."
# scp openclaw-extension.zip ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/
# ssh ${REMOTE_USER}@${REMOTE_HOST} "cd ${REMOTE_PATH} && unzip -o openclaw-extension.zip"
#
# echo "✅ Deployed to https://${REMOTE_HOST}/"

echo "Done! Upload openclaw-extension.zip to Edge Add-ons or Chrome Web Store."
