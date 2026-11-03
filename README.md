# PDF Theme Reader

[![Version](https://img.shields.io/badge/version-3.6.0-blue.svg)](https://github.com/yourusername/pdf-theme-reader/releases)
[![Manifest](https://img.shields.io/badge/manifest-v3-green.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PDF.js](https://img.shields.io/badge/PDF.js-6.4.299-red.svg)](https://github.com/mozilla/pdf.js)

A feature-rich Chrome PDF reader built on locally bundled [PDF.js](https://github.com/mozilla/pdf.js). No external servers, no tracking—just a fast, privacy-respecting PDF viewer with powerful reading tools.

---

## ✨ Features

### 📖 Reading Experience
- **15 Reading Themes** — 4 light, 11 dark; brightness & contrast controls; images preserve colors on dark themes
- **Flexible Zoom** — Buttons, presets, `Ctrl`+`wheel`, touchpad pinch, touch pinch; zooms the PDF, not the browser page
- **Fit Modes** — Fit page, fit width, automatic, actual size; remembered per document
- **Layouts** — Single page, two-page spread (book mode); rotate with `R` key
- **Fullscreen** — Distraction-free reading

### 🔍 Navigation & Search
- **Find** (`Ctrl`+`F`) — Every match highlighted, match case toggle, `F3`/`Enter` for next
- **Table of Contents** — Outline navigation with expand/collapse
- **Thumbnails** — Visual page navigation
- **Internal Links** — Footnotes, glossary, TOC links work (hover highlight, click to jump)
- **Document Info** — Metadata viewer

### 🖊️ Annotations & Notes
- **Highlights** — 5 colors, select text to highlight
- **Comments** — Add notes to highlights (auto-saved)
- **Notes Panel** — Lists all highlights & comments with page links
- **Export** — Notes exported as Markdown
- **Text-to-Speech** — Listen to selected text
- **Copy** — Formatted copy with citation

### 🌐 Translation
- **Selection Translate** — Translate any selected text
- **Double-click Word** — Quick translate single words
- **Target Language** — Configurable in popup (uses Google's public translate endpoint)

### 📂 File Handling
- **Open Files** — From popup, `Ctrl`+`O`, or drag & drop
- **Local Files** — Enable "Allow access to file URLs" in extension details
- **Password-Protected PDFs** — Prompt for password
- **Download** — Save PDF with annotations
- **Print** — Print all pages with proper scaling

### ⌨️ Keyboard Shortcuts
Press the **Keyboard Shortcuts** entry in the **More** menu (⋮) for the full list. Key defaults:

| Action | Shortcut |
|--------|----------|
| Toggle Find | `Ctrl`+`F` |
| Next Match | `F3` / `Enter` |
| Previous Match | `Shift`+`F3` / `Shift`+`Enter` |
| Rotate | `R` |
| Zoom In | `Ctrl`+`=` / `Ctrl`+`+` |
| Zoom Out | `Ctrl`+`-` |
| Actual Size | `Ctrl`+`0` |
| Fit Width | `Ctrl`+`Shift`+`W` |
| Fit Page | `Ctrl`+`Shift`+`P` |
| Toggle Fullscreen | `F11` |
| Next Page | `→` / `J` / `Space` |
| Previous Page | `←` / `K` / `Shift`+`Space` |
| First Page | `Home` |
| Last Page | `End` |
| Open File | `Ctrl`+`O` |
| Toggle Sidebar | `Ctrl`+`Shift`+`S` |

---

## 🚀 Installation

### Prerequisites
- Chrome / Edge / Brave / Vivaldi (Manifest V3 support)
- Git (optional, for cloning)

### Quick Start

1. **Clone or download** this repository
   ```bash
   git clone https://github.com/yourusername/pdf-theme-reader.git
   cd pdf-theme-reader
   ```

2. **Download PDF.js** (required — the extension won't work without it)
   - **macOS / Linux:**
     ```bash
     chmod +x tools/fetch-pdfjs.sh
     ./tools/fetch-pdfjs.sh
     # Add SLIM=1 to skip CJK character maps (saves ~1.7 MB):
     # SLIM=1 ./tools/fetch-pdfjs.sh
     ```
   - **Windows (PowerShell):**
     ```powershell
     .\tools\fetch-pdfjs.ps1
     # Add -Slim to skip CJK character maps:
     # .\tools\fetch-pdfjs.ps1 -Slim
     ```
   > ℹ️ The scripts download into a temp folder and clean up automatically. Only the `pdfjs/` folder is added to the project.

3. **Load the extension**
   - Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`, etc.)
   - Enable **Developer mode** (top right)
   - Click **Load unpacked** and select this folder

4. **Enable local file access** (for `file://` PDFs)
   - Go to the extension's details page
   - Toggle **Allow access to file URLs**

---

## 📁 Project Structure

```
pdf-theme-reader/
├── background.js          # Service worker: PDF URL interception
├── manifest.json          # Manifest V3 configuration
├── icons/                 # Extension icons (16–128px)
├── pdfjs/                 # PDF.js library (gitignored, downloaded via tools/)
├── popup/                 # Toolbar popup (open file, settings)
├── viewer/                # Main viewer UI
│   ├── viewer.html        # Viewer entry point
│   ├── viewer.js          # Core viewer logic
│   ├── viewer.css         # Styles
│   └── textsearch.js      # Find/highlight implementation
├── options/               # Options page (theme defaults, etc.)
└── tools/
    ├── fetch-pdfjs.sh     # macOS/Linux PDF.js downloader
    └── fetch-pdfjs.ps1    # Windows PDF.js downloader
```

---

## ⚙️ Configuration

### PDF.js Version
Edit `VERSION` in `tools/fetch-pdfjs.sh` / `tools/fetch-pdfjs.ps1` to upgrade/downgrade PDF.js.

### Slim Mode
Skip CJK character maps (Chinese/Japanese/Korean) to save ~1.7 MB:
```bash
SLIM=1 ./tools/fetch-pdfjs.sh        # macOS/Linux
.\tools\fetch-pdfjs.ps1 -Slim        # Windows
```

---

## 🛠️ Development

### Reloading Changes
1. Edit source files
2. Go to `chrome://extensions`
3. Click the **refresh** icon on the extension card

### Debugging
- **Viewer**: Open a PDF → DevTools (F12) on the viewer tab
- **Background**: `chrome://extensions` → "Service worker" link under the extension
- **Popup**: Right-click extension icon → Inspect popup

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Code Style
- ES modules (`type: module` in package.json if added)
- 2-space indentation
- Semicolons
- Descriptive variable names

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

### Third-Party Licenses
- **PDF.js** — Apache 2.0 / MIT (see `pdfjs/LICENSE`)
- **Standard Fonts** — See `pdfjs/standard_fonts/LICENSE_*`
- **WASM Decoders** — See `pdfjs/wasm/LICENSE_*`

---

## 🙏 Acknowledgments

- [Mozilla PDF.js](https://github.com/mozilla/pdf.js) — The amazing PDF rendering engine
- [Google Translate](https://translate.google.com/) — Translation endpoint (public, unofficial)
- All contributors and users who report issues and suggest features

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/pdf-theme-reader/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/pdf-theme-reader/discussions)

---

<p align="center">
  Made with ❤️ for PDF lovers everywhere
</p>
