"""
File utilities for AutoFigure SDK.
"""

import os
import tempfile
from pathlib import Path
from typing import Optional, Union


def ensure_dir(path: Union[str, Path]) -> Path:
    """
    Ensure a directory exists, creating it if necessary.

    Args:
        path: Directory path

    Returns:
        Path object for the directory
    """
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_text_file(path: Union[str, Path], encoding: str = "utf-8") -> Optional[str]:
    """
    Read text content from a file.

    Args:
        path: File path
        encoding: Text encoding

    Returns:
        File content, or None on failure
    """
    try:
        with open(path, "r", encoding=encoding) as f:
            return f.read()
    except Exception as e:
        print(f"[file_utils] Failed to read file {path}: {e}")
        return None


def write_text_file(
    path: Union[str, Path],
    content: str,
    encoding: str = "utf-8"
) -> bool:
    """
    Write text content to a file.

    Args:
        path: File path
        content: Text content to write
        encoding: Text encoding

    Returns:
        True on success, False on failure
    """
    try:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding=encoding) as f:
            f.write(content)
        return True
    except Exception as e:
        print(f"[file_utils] Failed to write file {path}: {e}")
        return False


def get_temp_path(suffix: str = "", prefix: str = "autofigure_") -> Path:
    """
    Get a temporary file path.

    Args:
        suffix: File suffix (e.g., '.svg')
        prefix: File prefix

    Returns:
        Path to a temporary file
    """
    fd, path = tempfile.mkstemp(suffix=suffix, prefix=prefix)
    os.close(fd)
    return Path(path)


def copy_file(src: Union[str, Path], dst: Union[str, Path]) -> bool:
    """
    Copy a file from source to destination.

    Args:
        src: Source file path
        dst: Destination file path

    Returns:
        True on success, False on failure
    """
    try:
        import shutil
        dst = Path(dst)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        return True
    except Exception as e:
        print(f"[file_utils] Failed to copy {src} to {dst}: {e}")
        return False


def get_file_extension(path: Union[str, Path]) -> str:
    """
    Get file extension (lowercase, without dot).

    Args:
        path: File path

    Returns:
        File extension (e.g., 'pdf', 'md')
    """
    return Path(path).suffix.lower().lstrip(".")


def is_pdf(path: Union[str, Path]) -> bool:
    """Check if a file is a PDF."""
    return get_file_extension(path) == "pdf"


def is_markdown(path: Union[str, Path]) -> bool:
    """Check if a file is a Markdown file."""
    return get_file_extension(path) in ("md", "markdown")
