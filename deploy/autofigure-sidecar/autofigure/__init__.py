"""
AutoFigure - AI-powered Scientific Figure Generation

A Python library for generating scientific figures using AI.

Example usage:
    ```python
    from autofigure import AutoFigureAgent, Config

    # Create configuration
    config = Config(
        generation_api_key="your-api-key",
        generation_provider="openrouter",  # or 'bianxie', 'gemini'
    )

    # Create agent
    agent = AutoFigureAgent(config)

    # Generate figure from description
    result = agent.generate(
        description="A flowchart showing the training pipeline of a transformer model",
        max_iterations=5,
        output_format="svg",  # 'svg' or 'mxgraphxml'
    )

    if result.success:
        print(f"SVG: {result.svg_path}")
        print(f"Preview: {result.preview_path}")
        print(f"Score: {result.final_score}")
    else:
        print(f"Error: {result.error}")

    # Generate from paper (PDF or Markdown)
    result = agent.generate_from_paper(
        paper_path="./paper.pdf",
        enable_enhancement=True,
    )
    ```
"""

__version__ = "0.1.0"
__author__ = "AutoFigure Team"

from .config import Config
from .agent import AutoFigureAgent, GenerationResult
from .extractor import MethodologyExtractor
from .enhancer import ImageEnhancer

__all__ = [
    "AutoFigureAgent",
    "Config",
    "GenerationResult",
    "MethodologyExtractor",
    "ImageEnhancer",
]
