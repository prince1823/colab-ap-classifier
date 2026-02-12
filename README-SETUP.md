# AP Classifier - Quick Start

## Setup Instructions

1. **Clone the repository**
   ```bash
   git clone <repo-url>
   cd ap-classfier
   ```

2. **Checkout the frontend branch**
   ```bash
   git checkout claude/objective-joliot
   ```

3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Run the development server**
   ```bash
   npm run dev
   ```

5. **Open the app**
   - The dev server will start on **http://localhost:5174/** (or 5173)
   - Open this URL in your browser
   - Navigate to the **Review** tab to see the classification dashboard

## What You'll See

✅ **Light-themed UI** with professional styling
✅ **Multi-table dashboard** (Supplier, Spend Category, GL Description)
✅ **Classification Path panel** with taxonomy breakdown
✅ **Filter panel** with drag-and-drop functionality
✅ **222 real healthcare transactions** from the sample dataset

## Project Structure

```
ap-classfier/
├── frontend-v1/          # React frontend (light theme UI)
│   ├── components/       # UI components
│   ├── pages/           # Page components (Review, etc.)
│   ├── styles/          # CSS files
│   └── main.tsx         # Entry point
├── public/              # Static assets
│   └── classified.csv   # Sample transaction data
├── index.html           # HTML entry point
├── vite.config.ts       # Vite configuration
├── tailwind.config.js   # Tailwind CSS config
└── postcss.config.js    # PostCSS config
```

## Notes

- The Electron main process requires `duckdb-async` which is not installed, but the web UI works fine without it
- The app defaults to the **Review** tab which shows the classification dashboard
- Sample data is included in `public/classified.csv`
