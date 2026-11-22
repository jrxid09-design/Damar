@echo off
rem DAMAR launcher (installed product). "damar help" lists the commands.
"%~dp0inherited-v53\node.exe" "%~dp0release\damar.cjs" %*
exit /b %ERRORLEVEL%
