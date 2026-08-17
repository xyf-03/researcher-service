"""
AutoFigure Agent Module.

Provides the main AutoFigureAgent class for generating scientific figures.
"""

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import Config
from .generator import figure_generator_pipeline, update_config_from_sdk
from .extractor import MethodologyExtractor
from .enhancer import ImageEnhancer


@dataclass
class GenerationResult:
    """
    Result of figure generation.

    Attributes:
        success: Whether generation was successful
        svg_path: Path to generated SVG file (if format includes SVG)
        mxgraph_path: Path to generated mxGraph XML file (if format includes mxGraph)
        enhanced_path: Path to first enhanced image (if enhancement was enabled)
        enhanced_paths: List of paths to all enhanced images (if multiple generated)
        preview_path: Path to PNG preview image
        final_score: Final quality score (0-10)
        iterations_used: Number of iterations used
        methodology_text: Extracted methodology text (if generated from paper)
        logs: List of log messages
        error: Error message if generation failed
    """
    success: bool = False
    svg_path: Optional[str] = None
    mxgraph_path: Optional[str] = None
    enhanced_path: Optional[str] = None
    enhanced_paths: List[str] = field(default_factory=list)
    preview_path: Optional[str] = None
    final_score: float = 0.0
    iterations_used: int = 0
    methodology_text: Optional[str] = None
    logs: List[str] = field(default_factory=list)
    error: Optional[str] = None


class AutoFigureAgent:
    """
    Main class for generating scientific figures using AI.

    Example usage:
        ```python
        from autofigure import AutoFigureAgent, Config

        config = Config(generation_api_key="your-api-key")
        agent = AutoFigureAgent(config)

        result = agent.generate(
            description="A flowchart showing the training pipeline",
            max_iterations=5
        )

        print(f"Generated: {result.svg_path}")
        ```
    """

    def __init__(self, config: Config):
        """
        Initialize AutoFigureAgent.

        Args:
            config: AutoFigure configuration
        """
        self.config = config
        self._extractor = None
        self._enhancer = None

        # Validate configuration
        errors = config.validate()
        if errors:
            print(f"[AutoFigureAgent] Configuration warnings: {errors}")

        # Update generator CONFIG from SDK config
        update_config_from_sdk(config)

    @property
    def extractor(self) -> MethodologyExtractor:
        """Lazy-load methodology extractor."""
        if self._extractor is None:
            self._extractor = MethodologyExtractor(self.config)
        return self._extractor

    @property
    def enhancer(self) -> ImageEnhancer:
        """Lazy-load image enhancer."""
        if self._enhancer is None:
            self._enhancer = ImageEnhancer(self.config)
        return self._enhancer

    def generate(
        self,
        description: str,
        max_iterations: Optional[int] = None,
        output_format: str = "svg",
        quality_threshold: Optional[float] = None,
        enable_enhancement: bool = False,
        art_style: Optional[str] = None,
        enhancement_input_type: Optional[str] = None,
        enhancement_count: Optional[int] = None,
        custom_references: Optional[List[str]] = None,
        output_dir: Optional[str] = None,
        topic: str = "paper",
    ) -> GenerationResult:
        """
        Generate a scientific figure from a text description.

        Args:
            description: Text description of the figure to generate
            max_iterations: Maximum iterations for refinement (overrides config)
            output_format: Output format - 'svg' or 'mxgraphxml'
            quality_threshold: Quality threshold to stop (overrides config)
            enable_enhancement: Whether to enhance the final image
            art_style: Art style for enhancement (overrides config)
            enhancement_input_type: Enhancement input type - 'none', 'code', 'code2prompt' (overrides config)
            enhancement_count: Number of enhanced image variants to generate (overrides config)
            custom_references: Custom reference figure paths
            output_dir: Output directory (overrides config)
            topic: Content type ('paper', 'survey', 'blog', 'textbook')

        Returns:
            GenerationResult with paths and metadata
        """
        result = GenerationResult()

        # Validate output_format
        valid_formats = ["svg", "mxgraphxml", "mxgraph"]
        if output_format not in valid_formats:
            result.success = False
            result.error = f"Invalid output_format '{output_format}'. Must be 'svg' or 'mxgraphxml'"
            return result

        # Normalize mxgraph to mxgraphxml
        if output_format == "mxgraph":
            output_format = "mxgraphxml"

        result.logs.append(f"Starting generation with format: {output_format}")

        # Override config settings if provided
        if max_iterations is not None:
            self.config.max_iterations = max_iterations
        if quality_threshold is not None:
            self.config.quality_threshold = quality_threshold
        if output_dir is not None:
            self.config.output_dir = output_dir
        if custom_references is not None:
            self.config.custom_references = custom_references

        # Update generator CONFIG with any changes
        update_config_from_sdk(self.config)

        # Ensure output directory exists
        os.makedirs(self.config.output_dir, exist_ok=True)

        # Get reference figures
        references = custom_references or self.config.get_references()

        # Create temp file for description content
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".md",
            delete=False,
            encoding="utf-8"
        ) as f:
            f.write(description)
            content_path = f.name

        try:
            # Call figure generator pipeline directly
            pipeline_result = figure_generator_pipeline(
                paper_path=content_path,
                reference_figures=references,
                topic=topic,
                output_format=output_format,
            )

            if pipeline_result and "error" not in pipeline_result:
                result.success = True
                result.final_score = pipeline_result.get("final_quality_score", 0)
                result.iterations_used = pipeline_result.get("total_iterations", 0)

                # Get output paths from pipeline result
                output_files = pipeline_result.get("output_files", {})
                final_code_path = output_files.get("final_code")
                final_png_path = output_files.get("final_png")

                if output_format == "svg":
                    result.svg_path = final_code_path
                    result.preview_path = final_png_path
                else:
                    result.mxgraph_path = final_code_path
                    result.preview_path = final_png_path

                # If paths not in result, look for files in output directory
                if not result.svg_path and not result.mxgraph_path:
                    output_dir_path = Path(self.config.output_dir)
                    if output_format == "svg":
                        svg_files = list(output_dir_path.glob("*.svg"))
                        if svg_files:
                            result.svg_path = str(max(svg_files, key=lambda p: p.stat().st_mtime))
                    else:
                        drawio_files = list(output_dir_path.glob("*.drawio"))
                        if drawio_files:
                            result.mxgraph_path = str(max(drawio_files, key=lambda p: p.stat().st_mtime))

                if not result.preview_path:
                    output_dir_path = Path(self.config.output_dir)
                    png_files = list(output_dir_path.glob("*.png"))
                    if png_files:
                        result.preview_path = str(max(png_files, key=lambda p: p.stat().st_mtime))

            else:
                result.success = False
                result.error = pipeline_result.get("error", "Generation failed") if pipeline_result else "Generation failed"

            # Enhancement (if enabled and successful)
            if enable_enhancement and result.success and result.preview_path:
                result.logs.append("Running image enhancement...")

                # Use parameter overrides or config defaults
                style = art_style if art_style is not None else self.config.art_style
                input_type = enhancement_input_type if enhancement_input_type is not None else self.config.enhancement_input_type
                count = enhancement_count if enhancement_count is not None else self.config.enhancement_count

                # Prepare enhancement input based on input type
                enhancement_input = ""

                # If using code input type and we have an SVG/mxGraph file, read it
                code_path = result.svg_path or result.mxgraph_path
                if input_type == "code" and code_path:
                    try:
                        with open(code_path, "r", encoding="utf-8") as f:
                            enhancement_input = f.read()
                        result.logs.append(f"Using code for enhancement ({len(enhancement_input)} chars)")
                    except Exception as e:
                        result.logs.append(f"Could not read code for enhancement: {e}")
                        input_type = "none"

                # Generate multiple enhanced images
                result.logs.append(f"Generating {count} enhanced image(s)...")
                for i in range(count):
                    # Generate unique output path for each variant
                    preview_path = Path(result.preview_path)
                    if count > 1:
                        output_path = str(preview_path.parent / f"{preview_path.stem}_enhanced_{i+1}.png")
                    else:
                        output_path = str(preview_path.parent / f"{preview_path.stem}_enhanced.png")

                    enhanced = self.enhancer.enhance(
                        input_path=result.preview_path,
                        output_path=output_path,
                        enhancement_input=enhancement_input,
                        style=style,
                        input_type=input_type,
                    )

                    if enhanced:
                        result.enhanced_paths.append(enhanced)
                        result.logs.append(f"Enhancement {i+1}/{count} complete: {enhanced}")
                    else:
                        result.logs.append(f"Enhancement {i+1}/{count} failed")

                # Set enhanced_path to the first successful enhancement for backward compatibility
                if result.enhanced_paths:
                    result.enhanced_path = result.enhanced_paths[0]
                    result.logs.append(f"Total {len(result.enhanced_paths)} enhanced image(s) generated")
                else:
                    result.logs.append("All enhancements failed (no API key or errors)")

        except Exception as e:
            result.success = False
            result.error = str(e)
            result.logs.append(f"Error: {e}")

        finally:
            # Clean up temp file
            try:
                os.unlink(content_path)
            except Exception:
                pass

        return result

    def generate_from_paper(
        self,
        paper_path: str,
        max_iterations: Optional[int] = None,
        output_format: str = "svg",
        enable_enhancement: bool = False,
        art_style: Optional[str] = None,
        enhancement_input_type: Optional[str] = None,
        enhancement_count: Optional[int] = None,
        custom_references: Optional[List[str]] = None,
        output_dir: Optional[str] = None,
        methodology_api_key: Optional[str] = None,
        methodology_provider: Optional[str] = None,
        methodology_model: Optional[str] = None,
        methodology_base_url: Optional[str] = None,
    ) -> GenerationResult:
        """
        Generate a figure by extracting methodology from a paper.

        Args:
            paper_path: Path to the paper file (PDF or Markdown)
            max_iterations: Maximum iterations for refinement
            output_format: Output format - 'svg' or 'mxgraphxml'
            enable_enhancement: Whether to enhance the final image
            art_style: Art style for enhancement (overrides config)
            enhancement_input_type: Enhancement input type (overrides config)
            enhancement_count: Number of enhanced image variants to generate (overrides config)
            custom_references: Custom reference figure paths
            output_dir: Output directory (overrides config)
            methodology_api_key: API key for methodology extraction LLM (overrides config)
            methodology_provider: Provider for methodology extraction (overrides config)
            methodology_model: Model for methodology extraction (overrides config)
            methodology_base_url: Base URL for methodology extraction API (overrides config)

        Returns:
            GenerationResult with paths and metadata
        """
        result = GenerationResult()
        result.logs.append(f"Extracting methodology from: {paper_path}")

        # Override methodology config if parameters provided
        original_methodology_api_key = self.config.methodology_api_key
        original_methodology_provider = self.config.methodology_provider
        original_methodology_model = self.config.methodology_model
        original_methodology_base_url = self.config.methodology_base_url

        if methodology_api_key is not None:
            self.config.methodology_api_key = methodology_api_key
        if methodology_provider is not None:
            self.config.methodology_provider = methodology_provider
            # Update base URL for new provider if not explicitly set
            if methodology_base_url is None:
                self.config.methodology_base_url = self.config._get_default_base_url(methodology_provider)
        if methodology_model is not None:
            self.config.methodology_model = methodology_model
        if methodology_base_url is not None:
            self.config.methodology_base_url = methodology_base_url

        # Reset extractor to pick up new config
        self._extractor = None

        try:
            # Extract methodology from paper
            methodology = self.extractor.extract_from_file(paper_path)

            if not methodology:
                result.success = False
                result.error = "Failed to extract methodology from paper"
                return result

            result.methodology_text = methodology
            result.logs.append(f"Extracted {len(methodology)} chars of methodology")

            # Generate figure using extracted methodology
            gen_result = self.generate(
                description=methodology,
                max_iterations=max_iterations,
                output_format=output_format,
                enable_enhancement=enable_enhancement,
                art_style=art_style,
                enhancement_input_type=enhancement_input_type,
                enhancement_count=enhancement_count,
                custom_references=custom_references,
                output_dir=output_dir,
                topic="paper",
            )

            # Merge results
            result.success = gen_result.success
            result.svg_path = gen_result.svg_path
            result.mxgraph_path = gen_result.mxgraph_path
            result.enhanced_path = gen_result.enhanced_path
            result.enhanced_paths = gen_result.enhanced_paths
            result.preview_path = gen_result.preview_path
            result.final_score = gen_result.final_score
            result.iterations_used = gen_result.iterations_used
            result.logs.extend(gen_result.logs)
            result.error = gen_result.error

            return result

        finally:
            # Restore original methodology config
            self.config.methodology_api_key = original_methodology_api_key
            self.config.methodology_provider = original_methodology_provider
            self.config.methodology_model = original_methodology_model
            self.config.methodology_base_url = original_methodology_base_url
            # Reset extractor to use restored config
            self._extractor = None

    def generate_from_file(
        self,
        content_path: str,
        max_iterations: Optional[int] = None,
        output_format: str = "svg",
        enable_enhancement: bool = False,
        art_style: Optional[str] = None,
        enhancement_input_type: Optional[str] = None,
        enhancement_count: Optional[int] = None,
        custom_references: Optional[List[str]] = None,
        output_dir: Optional[str] = None,
        topic: str = "paper",
    ) -> GenerationResult:
        """
        Generate a figure from a content file (Markdown or text).

        The file should contain a description of the figure to generate.

        Args:
            content_path: Path to the content file
            max_iterations: Maximum iterations for refinement
            output_format: Output format - 'svg' or 'mxgraphxml'
            enable_enhancement: Whether to enhance the final image
            art_style: Art style for enhancement (overrides config)
            enhancement_input_type: Enhancement input type (overrides config)
            enhancement_count: Number of enhanced image variants to generate (overrides config)
            custom_references: Custom reference figure paths
            output_dir: Output directory (overrides config)
            topic: Content type ('paper', 'survey', 'blog', 'textbook')

        Returns:
            GenerationResult with paths and metadata
        """
        result = GenerationResult()

        # Read content file
        try:
            with open(content_path, "r", encoding="utf-8") as f:
                description = f.read()
        except Exception as e:
            result.success = False
            result.error = f"Failed to read content file: {e}"
            return result

        if not description.strip():
            result.success = False
            result.error = "Content file is empty"
            return result

        result.logs.append(f"Read {len(description)} chars from {content_path}")

        return self.generate(
            description=description,
            max_iterations=max_iterations,
            output_format=output_format,
            enable_enhancement=enable_enhancement,
            art_style=art_style,
            enhancement_input_type=enhancement_input_type,
            enhancement_count=enhancement_count,
            custom_references=custom_references,
            output_dir=output_dir,
            topic=topic,
        )
