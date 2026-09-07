````markdown
# Data Deception Agents – Setup & Run Guide

## Prerequisites

Before running the project, install the following:

- Node.js (v18 or later recommended)
- Git for Windows
- Bash (comes with Git for Windows)
- Google Gemini API Key
- Internet connection

---

# Project Structure

```text
data deception/
│
├── source-credibility-agent/
├── claim-extraction-agent/
├── Cross-Modal Contradiction Agent/
├── deepfake-evidence-agent/
├── evidence-retrieval-agent/
├── image-deepfake-agent/
├── scam-detection-agent/
└── consensus engine/
````

---

# Environment Variables

Some agents that use Google Gemini require a `.env` file.

Create a `.env` file inside the respective agent's `backend` folder.

Example:

```env
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
GEMINI_MODEL=gemini-flash-latest
```

Replace `YOUR_GEMINI_API_KEY` with your actual Google Gemini API key.

Example location:

```text
C:\Users\gagan\Downloads\WALMART\data deception\data deception\scam-detection-agent\backend\.env
```

---

# Running the Agents

Open separate PowerShell terminals for each agent.

> Important: Run `start.sh` only once for each agent. Do not run `node server.js` again after `start.sh`.

## 1. Source Credibility Agent

```powershell
cd "C:\Users\gagan\Downloads\WALMART\data deception\data deception\source-credibility-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
```

---

## 2. Claim Extraction Agent

```powershell
cd "C:\Users\gagan\Downloads\WALMART\data deception\data deception\claim-extraction-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
```

---

## 3. Cross-Modal Contradiction Agent

```powershell
cd "C:\Users\gagan\Downloads\WALMART\data deception\data deception\Cross-Modal Contradiction Agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
```

---

## 4. Deepfake Evidence Agent

```powershell
cd "C:\Users\gagan\Downloads\WALMART\data deception\data deception\deepfake-evidence-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
```

---

## 5. Evidence Retrieval Agent

```powershell
cd "C:\Users\gagan\Downloads\WALMART\data deception\data deception\evidence-retrieval-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
```

---

## 6. Image Deepfake Agent

```powershell
cd "C:\Users\gagan\Downloads\WALMART\data deception\data deception\image-deepfake-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
```

---

## 7. Scam Detection Agent

```powershell
cd "C:\Users\gagan\Downloads\WALMART\data deception\data deception\scam-detection-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
```

---

## 8. Consensus Engine

Start the Consensus Engine after starting all the required agents.

```powershell
cd "C:\Users\gagan\Downloads\WALMART\data deception\data deception\consensus engine"
& "C:\Program Files\Git\bin\bash.exe" start.sh
```

---

# Expected Output

If an agent starts successfully, you should see output similar to:

```text
Starting backend on http://localhost:PORT

Agent Started
```

For agents using Google Gemini, the output may also display:

```text
Provider → Google Gemini
Model → gemini-flash-latest
Key set → yes
```

---

# Stopping an Agent

To stop an agent, press:

```text
Ctrl + C
```

inside the PowerShell terminal where that agent is running.

---

# Troubleshooting

## 1. Bash Not Found

Install **Git for Windows** and ensure the following file exists:

```text
C:\Program Files\Git\bin\bash.exe
```

---

## 2. Missing API Key

Ensure the required `.env` file exists inside the agent's `backend` folder.

Example:

```env
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
```

---

## 3. Port Already in Use

If you receive an error similar to:

```text
EADDRINUSE: address already in use
```

Check which process is using the port:

```powershell
netstat -ano | findstr :PORT_NUMBER
```

For example:

```powershell
netstat -ano | findstr :8005
```

Then terminate the process using its PID:

```powershell
taskkill /PID YOUR_PID /F
```

After the port is free, start the agent again.

---

## 4. Gemini API Error 429

If you receive:

```text
429 RESOURCE_EXHAUSTED
```

it means the Gemini API quota or rate limit has been exceeded.

Check your Gemini API usage and rate limits before retrying.

---

## 5. Gemini API Error 503

If you receive:

```text
503 UNAVAILABLE
```

the Gemini service may be experiencing high demand.

Wait for some time and try again.

---

# Important Notes

* Start each agent in a separate PowerShell terminal.
* Keep all agent terminals running while using the application.
* Run `start.sh` only once for each agent.
* Do not run `node server.js` separately after running `start.sh`.
* Make sure every agent is using a different port.
* Start the Consensus Engine after the other required agents are running.
* If any agent fails to start, check the terminal logs for the error message.

```

### Main fixes I made:
- Added **Evidence Retrieval Agent**
- Added **Consensus Engine as Agent 8 at the end**
- Changed **six terminals → separate terminals for all agents**
- Removed unnecessary `node server.js` commands
- Added correct troubleshooting for your **EADDRINUSE port 8005 error**
- Updated the path to match your actual project location shown in the terminal.
```
