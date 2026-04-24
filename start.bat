@echo off
echo Starting Examjet...
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is not installed!
    echo Please download and install it from https://nodejs.org
    echo.
    pause
    exit
)

if not exist node_modules (
    echo Installing dependencies...
    npm install
    echo.
)

echo Examjet is running!
echo Open your browser and go to http://localhost:3000
echo Share your local network IP with students.
echo.
echo Press Ctrl+C to stop the server.
echo.
node server.js
pause
