@echo off
REM Script to build all Docker images for code execution (Windows)
REM Run this script from the codingPlatformNode directory

echo Building Docker images for code execution...

REM Get the directory where this script is located
set SCRIPT_DIR=%~dp0
set DOCKER_DIR=%SCRIPT_DIR%docker

REM Build JavaScript compiler image
echo Building javascript-compiler...
docker build -t javascript-compiler:latest "%DOCKER_DIR%\javascript"
if %errorlevel% neq 0 (
    echo Failed to build javascript-compiler
    exit /b %errorlevel%
)

REM Build Python compiler image
echo Building python-compiler...
docker build -t python-compiler:latest "%DOCKER_DIR%\python"
if %errorlevel% neq 0 (
    echo Failed to build python-compiler
    exit /b %errorlevel%
)

REM Build Java compiler image
echo Building java-compiler...
docker build -t java-compiler:latest "%DOCKER_DIR%\java"
if %errorlevel% neq 0 (
    echo Failed to build java-compiler
    exit /b %errorlevel%
)

REM Build C compiler image
echo Building c-compiler...
docker build -t c-compiler:latest "%DOCKER_DIR%\c"
if %errorlevel% neq 0 (
    echo Failed to build c-compiler
    exit /b %errorlevel%
)

REM Build C++ compiler image
echo Building cpp-compiler...
docker build -t cpp-compiler:latest "%DOCKER_DIR%\cpp"
if %errorlevel% neq 0 (
    echo Failed to build cpp-compiler
    exit /b %errorlevel%
)

REM Build PHP compiler image
echo Building php-compiler...
docker build -t php-compiler:latest "%DOCKER_DIR%\php"
if %errorlevel% neq 0 (
    echo Failed to build php-compiler
    exit /b %errorlevel%
)

REM Build Ruby compiler image
echo Building ruby-compiler...
docker build -t ruby-compiler:latest "%DOCKER_DIR%\ruby"
if %errorlevel% neq 0 (
    echo Failed to build ruby-compiler
    exit /b %errorlevel%
)

REM Build Go compiler image
echo Building go-compiler...
docker build -t go-compiler:latest "%DOCKER_DIR%\go"
if %errorlevel% neq 0 (
    echo Failed to build go-compiler
    exit /b %errorlevel%
)

echo.
echo All Docker images built successfully!
echo.
echo Built images:
docker images | findstr /i "javascript-compiler python-compiler java-compiler c-compiler cpp-compiler php-compiler ruby-compiler go-compiler"

