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

```
data deception/
│
├── source-credibility-agent/
├── claim-extraction-agent/
├── Cross-Modal Contradiction Agent/
├── deepfake-evidence-agent/
├── image-deepfake-agent/
└── scam-detection-agent/
```

---

# Environment Variables

Only the **Scam Detection Agent** requires a `.env` file.

Create the following file:

```
C:\Users\data deception\data deception\scam-detection-agent\backend\.env
```

Example:

```env
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
```

Replace `YOUR_GEMINI_API_KEY` with your actual Google Gemini API key.

---

# Running the Agents

Open **six different PowerShell terminals**.

## 1. Source Credibility Agent

```powershell
cd "C:\Users\data deception\data deception\source-credibility-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
node server.js
```

---

## 2. Claim Extraction Agent

```powershell
cd "C:\Users\data deception\data deception\claim-extraction-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
node server.js
```

---

## 3. Cross-Modal Contradiction Agent

```powershell
cd "C:\Users\data deception\data deception\Cross-Modal Contradiction Agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
node server.js
```

---

## 4. Deepfake Evidence Agent

```powershell
cd "C:\Users\data deception\data deception\deepfake-evidence-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
node server.js
```

---

## 5. Image Deepfake Agent

```powershell
cd "C:\Users\data deception\data deception\image-deepfake-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
node server.js
```

---

## 6. Scam Detection Agent

```powershell
cd "C:\Users\data deception\data deception\scam-detection-agent"
& "C:\Program Files\Git\bin\bash.exe" start.sh
node server.js
```

---

# Expected Output

If an agent starts successfully, you should see output similar to:

```
🚀 Starting backend on http://localhost:8000

🧩 Agent Started

Provider → Google Gemini
Model → gemini-flash-latest
Key set → yes ✓
```

---

# Stopping an Agent

Press:

```
Ctrl + C
```

inside the terminal.

---

# Troubleshooting

## 1. 'bash' not found

Install **Git for Windows** and ensure:

```
C:\Program Files\Git\bin\bash.exe
```

exists.

---

## 2. Missing API Key

Ensure the `.env` file exists at:

```
C:\Users\data deception\data deception\scam-detection-agent\backend\.env
```

with:

```env
GEMINI_API_KEY=YOUR_API_KEY
```

---

## 3. Port Already in Use

Terminate the existing process using the port or stop the previously running agent before restarting.

---

# Notes

- Start each agent in a separate PowerShell terminal.
- Keep all terminals running while using the application.
- If any agent fails to start, check the terminal logs for the error message.