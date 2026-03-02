@echo off
cd /d "C:\Data\Gitrepo\Tempo Booking"
if errorlevel 1 (
    echo ERROR: Could not change to directory
    pause
    exit /b
)
cmd /k "npm run book || echo. && echo Command failed with error code: %errorlevel% && pause"