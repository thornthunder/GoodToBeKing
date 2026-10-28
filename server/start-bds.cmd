@echo off
rem Starts the Bedrock server through start-bds.ps1, which gives Merlin operator rights each time he joins.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bds.ps1" %*
