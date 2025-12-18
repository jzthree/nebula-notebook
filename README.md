# Nebula Notebook

A modern, web-based notebook interface for interactive computing with real Jupyter kernels, multi-provider LLM support, and real filesystem access.

## Quick Install

```bash
# Clone and install
git clone https://github.com/jzthree/nebula-notebook.git
cd nebula-notebook
npm install
cd server && pip install -r requirements.txt && cd ..

# Configure API keys (at least one required for AI features)
cp server/.env.example server/.env
# Edit server/.env with your API keys

# Run
npm run start
```

Open http://localhost:3000 in your browser.

## Features

- **Real Jupyter Kernels** - Execute code using actual Jupyter kernels (Python, Julia, R, etc.)
- **Multi-Provider LLM Support** - AI assistance powered by Google Gemini, OpenAI, or Anthropic
- **Real Filesystem** - Browse and edit notebooks from your actual filesystem
- **Autosave** - Never lose your work with automatic saving and crash recovery
- **Modern UI** - Clean, responsive interface with cell-based editing

## Prerequisites

- Node.js 18+
- Python 3.10+
- Jupyter kernels installed (e.g., `pip install ipykernel`)

## Setup

### 1. Install dependencies

```bash
# Frontend dependencies
npm install

# Backend dependencies
cd server
pip install -r requirements.txt
```

### 2. Configure API keys

Copy the example environment file and add your API keys:

```bash
cp server/.env.example server/.env
```

Edit `server/.env` with your API keys (at least one is required for AI features):

```
GEMINI_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
```

### 3. Run the application

```bash
# Start both frontend and backend
npm run start
```

Or run them separately:

```bash
# Terminal 1: Backend (FastAPI)
npm run server

# Terminal 2: Frontend (Vite)
npm run dev
```

Open http://localhost:3000 in your browser.

## Project Structure

```
nebula-notebook/
├── components/       # React components
├── hooks/           # Custom React hooks
├── services/        # Frontend services (kernel, LLM, filesystem)
├── server/          # Python FastAPI backend
│   ├── main.py           # API endpoints
│   ├── kernel_service.py # Jupyter kernel management
│   ├── llm_service.py    # Multi-provider LLM service
│   └── fs_service.py     # Filesystem operations
├── types.ts         # TypeScript type definitions
└── vite.config.ts   # Vite configuration
```

## Tech Stack

**Frontend:**
- React 19 + TypeScript
- Vite
- Tailwind CSS
- Lucide Icons

**Backend:**
- FastAPI
- jupyter_client (kernel management)
- OpenAI, Anthropic, Google GenAI SDKs

## License

MIT
