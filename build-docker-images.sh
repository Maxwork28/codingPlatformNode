#!/bin/bash

# Script to build all Docker images for code execution
# Run this script from the codingPlatformNode directory

set -e

echo "Building Docker images for code execution..."

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DOCKER_DIR="$SCRIPT_DIR/docker"

# Build JavaScript compiler image
echo "Building javascript-compiler..."
docker build -t javascript-compiler:latest "$DOCKER_DIR/javascript"

# Build Python compiler image
echo "Building python-compiler..."
docker build -t python-compiler:latest "$DOCKER_DIR/python"

# Build Java compiler image
echo "Building java-compiler..."
docker build -t java-compiler:latest "$DOCKER_DIR/java"

# Build C compiler image
echo "Building c-compiler..."
docker build -t c-compiler:latest "$DOCKER_DIR/c"

# Build C++ compiler image
echo "Building cpp-compiler..."
docker build -t cpp-compiler:latest "$DOCKER_DIR/cpp"

# Build PHP compiler image
echo "Building php-compiler..."
docker build -t php-compiler:latest "$DOCKER_DIR/php"

# Build Ruby compiler image
echo "Building ruby-compiler..."
docker build -t ruby-compiler:latest "$DOCKER_DIR/ruby"

# Build Go compiler image
echo "Building go-compiler..."
docker build -t go-compiler:latest "$DOCKER_DIR/go"

echo ""
echo "All Docker images built successfully!"
echo ""
echo "Built images:"
docker images | grep -E "(javascript-compiler|python-compiler|java-compiler|c-compiler|cpp-compiler|php-compiler|ruby-compiler|go-compiler)"

