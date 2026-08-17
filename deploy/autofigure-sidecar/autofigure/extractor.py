"""
Methodology Extractor for AutoFigure SDK.

Extracts methodology descriptions from academic papers (PDF or Markdown)
for figure generation.
"""

from pathlib import Path
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .config import Config

# Methodology extraction prompt
EXTRACTION_PROMPT = """You are a highly discerning AI assistant for academic literature analysis. Your task is to extract ONLY the core theoretical and algorithmic methodology of a scientific paper.

**Core Objective:**
Isolate and extract the section(s) that describe the central innovation of the paper. This section answers the question, "What is the authors' core proposed method, model, or framework?" It should NOT describe how this method was tested or evaluated.

**Guiding Principles & Identification Criteria (What to INCLUDE):**
You must identify and extract the section(s) based on their semantic content. A section should be extracted if it primarily describes:
- The mathematical formulation or theoretical underpinnings of the work.
- The architecture of a novel model or system.
- The steps of a new algorithm.
- The conceptual framework being proposed.
- Common headings include "Method", "Our Approach", "Proposed Model/Framework", "Algorithm".

**Strict Exclusion Criteria (What to EXCLUDE):**
You MUST actively identify and exclude sections that, while related, are not part of the core methodology. DO NOT extract sections primarily describing:
- **Datasets:** Descriptions of data sources, collection methods, or statistics.
- **Experimental Setup:** Details about hardware, software environments, hyperparameters, or implementation specifics.
- **Evaluation Metrics:** Definitions of metrics like Accuracy, F1-Score, PSNR, etc.
- **Results or Ablation Studies:** Any reporting of experimental outcomes.
- Common headings to exclude are "Experiments", "Evaluation", "Dataset", "Implementation Details", "Results".

**Execution Rules:**
1.  **Verbatim Extraction:** Extract the qualifying section(s) verbatim, with original headings. Do not alter the text.
2.  **Boundary Detection:** Start the extraction at the section's heading and stop before a section that should be excluded (e.g., stop before `## Experiments` or `## Results`).
3.  **Output Format:** Produce only the raw Markdown content. Add no commentary.

--- PAPER MARKDOWN START ---
{content}
--- PAPER MARKDOWN END ---"""


class MethodologyExtractor:
    """
    Extracts methodology descriptions from papers for figure generation.
    """

    def __init__(self, config: "Config"):
        """
        Initialize the methodology extractor.

        Args:
            config: AutoFigure SDK configuration
        """
        self.config = config
        self._llm_client = None

    @property
    def llm_client(self):
        """Lazy-load LLM client."""
        if self._llm_client is None:
            from .utils.llm_client import create_client_from_config
            self._llm_client = create_client_from_config(self.config, purpose="methodology")
        return self._llm_client

    def extract_from_file(self, file_path: str) -> Optional[str]:
        """
        Extract methodology from a file (PDF or Markdown).

        Args:
            file_path: Path to the paper file

        Returns:
            Extracted methodology description, or None on failure
        """
        path = Path(file_path)

        if not path.exists():
            print(f"[MethodologyExtractor] File not found: {file_path}")
            return None

        # Read content based on file type
        content = self._read_file_content(path)
        if not content:
            return None

        return self.extract_from_text(content)

    def extract_from_text(self, text: str) -> Optional[str]:
        """
        Extract methodology from raw text content.

        Args:
            text: Paper text content

        Returns:
            Extracted methodology description, or None on failure
        """
        if not text or len(text.strip()) < 100:
            print("[MethodologyExtractor] Text content too short")
            return None

        # Truncate if too long (keep first ~50k chars to fit in context)
        max_chars = 50000
        if len(text) > max_chars:
            print(f"[MethodologyExtractor] Truncating content from {len(text)} to {max_chars} chars")
            text = text[:max_chars]

        prompt = EXTRACTION_PROMPT.format(content=text)

        print("[MethodologyExtractor] Extracting methodology with LLM...")
        result = self.llm_client.call([prompt], temperature=0.3)

        if result:
            print(f"[MethodologyExtractor] Extracted {len(result)} chars of methodology")
        else:
            print("[MethodologyExtractor] Failed to extract methodology")

        return result

    def _read_file_content(self, path: Path) -> Optional[str]:
        """
        Read content from a file based on its type.

        Args:
            path: File path

        Returns:
            File content as text, or None on failure
        """
        suffix = path.suffix.lower()

        if suffix == ".pdf":
            return self._read_pdf(path)
        elif suffix in (".md", ".markdown", ".txt"):
            return self._read_text(path)
        else:
            print(f"[MethodologyExtractor] Unsupported file type: {suffix}")
            return None

    def _read_text(self, path: Path) -> Optional[str]:
        """Read plain text or markdown file."""
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            print(f"[MethodologyExtractor] Failed to read text file: {e}")
            return None

    def _read_pdf(self, path: Path) -> Optional[str]:
        """
        Read PDF file content using available libraries.
        Tries multiple methods in order of preference.
        """
        # Method 1: Try PyMuPDF (fitz)
        try:
            import fitz
            doc = fitz.open(str(path))
            text_content = ""
            for page in doc:
                text_content += page.get_text()
            doc.close()
            if text_content.strip():
                print("[MethodologyExtractor] Read PDF with PyMuPDF")
                return text_content
        except ImportError:
            pass
        except Exception as e:
            print(f"[MethodologyExtractor] PyMuPDF failed: {e}")

        # Method 2: Try pdfplumber
        try:
            import pdfplumber
            text_content = ""
            with pdfplumber.open(str(path)) as pdf:
                for page in pdf.pages:
                    page_text = page.extract_text()
                    if page_text:
                        text_content += page_text + "\n"
            if text_content.strip():
                print("[MethodologyExtractor] Read PDF with pdfplumber")
                return text_content
        except ImportError:
            pass
        except Exception as e:
            print(f"[MethodologyExtractor] pdfplumber failed: {e}")

        # Method 3: Try PyPDF2
        try:
            import PyPDF2
            text_content = ""
            with open(path, "rb") as file:
                pdf_reader = PyPDF2.PdfReader(file)
                for page in pdf_reader.pages:
                    text_content += page.extract_text() + "\n"
            if text_content.strip():
                print("[MethodologyExtractor] Read PDF with PyPDF2")
                return text_content
        except ImportError:
            pass
        except Exception as e:
            print(f"[MethodologyExtractor] PyPDF2 failed: {e}")

        print("[MethodologyExtractor] No PDF reader available. Install pymupdf, pdfplumber, or PyPDF2")
        return None
