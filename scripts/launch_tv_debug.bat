@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Kill existing TradingView instances
REM Sleeps use ping, not timeout: "timeout" aborts with "Input redirection is
REM not supported" whenever stdin is redirected, which is how this script runs
REM when spawned by tv_launch rather than typed into a console.
taskkill /F /IM TradingView.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul

REM Auto-detect TradingView install location
set "TV_EXE="

REM Check common install locations
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM Check MSIX / Windows Store installs
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('dir /s /b "%PROGRAMFILES%\WindowsApps\TradingView*\TradingView.exe" 2^>nul') do set "TV_EXE=%%i"
)
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('where TradingView.exe 2^>nul') do set "TV_EXE=%%i"
)

if "%TV_EXE%"=="" (
    echo Error: TradingView not found.
    echo Checked: %%LOCALAPPDATA%%\TradingView, %%PROGRAMFILES%%\TradingView, WindowsApps
    echo.
    echo If installed elsewhere, run manually:
    echo   "C:\path\to\TradingView.exe" --remote-debugging-port=%PORT%
    exit /b 1
)

echo Found TradingView at: %TV_EXE%
echo Starting with --remote-debugging-port=%PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%PORT%

echo Waiting for CDP to become available...
ping -n 6 127.0.0.1 >nul

REM Poll for at most MAX_TRIES attempts, 2 seconds apart, then give up
set /a TRIES=0
set /a MAX_TRIES=30

:check
curl -s http://localhost:%PORT%/json/version >nul 2>&1
if %errorlevel% equ 0 goto ready
set /a TRIES+=1
if %TRIES% geq %MAX_TRIES% goto giveup
echo Still waiting... (%TRIES%/%MAX_TRIES%)
ping -n 3 127.0.0.1 >nul
goto check

:giveup
echo.
echo Error: CDP never came up on port %PORT% after %MAX_TRIES% attempts.
echo.
echo Things to check:
echo   - Is TradingView actually running? It may have failed to start.
echo   - Is another process already using port %PORT%? Try a different port:
echo       scripts\launch_tv_debug.bat 9333
echo   - Was TradingView launched from an MSIX / Microsoft Store install?
echo     Those drop command-line arguments, so --remote-debugging-port is ignored.
echo   - Launched exe was: %TV_EXE%
exit /b 1

:ready
echo.
echo CDP ready at http://localhost:%PORT%
curl -s http://localhost:%PORT%/json/version
echo.
exit /b 0
