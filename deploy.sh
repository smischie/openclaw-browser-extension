#!/bin/bash
# Rebuild deploy tarball (no .git)
cd ~/projects/openclaw-extension
tar czf /tmp/openclaw-ext.tar.gz --exclude='.git' --exclude='deploy.sh' --exclude='node_modules' --exclude='tests' --exclude='vitest.config.js' --exclude='package.json' --exclude='package-lock.json' .
echo "Deploy tarball ready: /tmp/openclaw-ext.tar.gz ($(du -h /tmp/openclaw-ext.tar.gz | cut -f1))"
echo ""