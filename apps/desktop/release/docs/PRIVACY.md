# Privacy

DAMAR runs on your computer and keeps its data in `%LOCALAPPDATA%\DAMAR`. It has no DAMAR account, no DAMAR cloud service, and no analytics component.

## What leaves your machine, and when
| Destination | When | What is sent |
|---|---|---|
| The model provider you connect | Only for models you granted, when you run a turn or a sub-agent | Your request, the conversation context Core selects (the 8 most recent messages plus relevant older ones), project-memory notes for the workspace, tool definitions, and the content of the workspace files and command output that the agent reads during the turn. Your API key is sent to that provider only. |
| Mata Dewa public feeds: USGS, Open-Meteo, adsb.lol, CelesTrak, The Space Devs | Only after you enable Mata Dewa in Control and give consent | HTTPS requests without credentials. They reveal your public IP address and the coordinates of the areas of interest you configured. |
| Python package index and GitHub releases | Only when you choose **Install ALPR engine** for Mata Dewa cameras in Control | Downloads of pinned packages and the two recognition models, into `%LOCALAPPDATA%\DAMAR\alpr`. Nothing about you is sent beyond the normal download requests. |
| Your own cameras (Mata Dewa) | Only cameras you add | Frames are read from the camera address you configure. Number-plate recognition, if installed, runs locally. |
| Websites you approve for computer use | Only for the exact URL origin you approved | Whatever the automated browser does on that site |

DAMAR sends nothing to its authors. Your provider's own privacy policy applies to what you send it. With a local server (Ollama, LM Studio, or another OpenAI-compatible server on `127.0.0.1`), model traffic never leaves your computer.

To stop all outbound connections from Core, set `DAMAR_EGRESS=loopback` before starting it.

## What is stored locally
- Session history, agent turn journals, usage receipts, checkpoints (the earlier contents of files DAMAR changed) and project memory, in `%LOCALAPPDATA%\DAMAR\sessions`.
- CLI preferences and Core settings, in `%LOCALAPPDATA%\DAMAR\profile`.
- API keys only if you tick *Remember key*. They are encrypted with Windows DPAPI for your user.
- Computer-use screen captures, in the private folder of the current Core session. They are sent to a model only if the active model is verified to accept images.
- `/export` writes a transcript to your profile folder.

## Deleting your data
Stop DAMAR (`damar shutdown`) and delete `%LOCALAPPDATA%\DAMAR`, or uninstall and answer **Yes** to "Also remove your DAMAR data?". Data you sent to a provider is governed by that provider.
