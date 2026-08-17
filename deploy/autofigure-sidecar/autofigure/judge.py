import os
import json
import time
import random
import uuid
from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional
from PIL import Image
import io
from google import genai
from google.genai import types
import matplotlib.pyplot as plt
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor, as_completed

# Configuration - API key should be set via environment variable
CONFIG = {
    'GOOGLE_API_KEY': os.environ.get('GOOGLE_API_KEY', ''),  # Set via environment variable
    'MAX_RETRIES': 3,
    'EVALUATION_ROUNDS': 1,
    'MAX_PARALLEL_WORKERS': 3,
    'BASE_DELAY': 5,  # Base delay in seconds
    'MAX_DELAY': 200,  # Maximum delay in seconds
}

# Multi-provider unified API entry point (supports OpenAI-compatible APIs)
try:
    from openai import OpenAI as _OpenAICompat
    import base64 as _b64
    import io as _io
    from PIL import Image as _PILImage
except Exception:
    _OpenAICompat = None
    _PILImage = None

def _call_provider_unified(contents: list, provider: str,
                           api_key: str = None, model: str = None, base_url: str = None) -> Optional[str]:
    """
    Unified entry point for multiple LLM providers.
    Uses Google GenAI for 'gemini', OpenAI-compatible API for others.
    """
    if provider == 'gemini':
        return call_google_genai_multimodal(contents, api_key=api_key)

    if _OpenAICompat is None or _PILImage is None:
        print('OpenAI-compatible client or PIL not available')
        return None

    try:
        client = _OpenAICompat(api_key=api_key, base_url=base_url)
        content_parts = []
        for part in contents:
            if isinstance(part, str):
                content_parts.append({'type': 'text', 'text': part})
            elif isinstance(part, _PILImage.Image):
                buf = _io.BytesIO()
                part.save(buf, format='PNG')
                image_b64 = _b64.b64encode(buf.getvalue()).decode('utf-8')
                content_parts.append({'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{image_b64}'}})
        completion = client.chat.completions.create(model=model or 'google/gemini-3.1-pro-preview', messages=[{
            'role': 'user', 'content': content_parts
        }])
        return completion.choices[0].message.content if completion and completion.choices else None
    except Exception as e:
        print(f'Provider API call failed: {e}')
        return None

def call_google_genai_multimodal(contents: List, api_key: str = None, retry_count: int = 0) -> Optional[str]:
    """
    Calls the Google GenAI multimodal API with intelligent retry logic.
    
    Args:
        contents: List of content including text and images.
        api_key: Google API key.
        retry_count: Current retry attempt number.
    
    Returns:
        LLM response text, or None on failure.
    """
    try:
        if api_key is None:
            api_key = CONFIG['GOOGLE_API_KEY']
            
        # Configure the client
        client = genai.Client(api_key=api_key)
        
        # Build the list of API contents
        api_contents = []
        for content_part in contents:
            if isinstance(content_part, str):
                api_contents.append(content_part)
            elif isinstance(content_part, Image.Image):
                # Convert PIL image to bytes
                img_byte_arr = io.BytesIO()
                content_part.save(img_byte_arr, format='PNG')
                image_bytes = img_byte_arr.getvalue()
                
                # Create image part
                api_contents.append(types.Part.from_bytes(
                    data=image_bytes,
                    mime_type='image/png',
                ))
            else:
                print(f" Warning: Skipping unsupported content type: {type(content_part)}")

        # Adaptive rate limiting based on retry count
        base_delay = CONFIG['BASE_DELAY']
        delay = min(base_delay * (2 ** retry_count), CONFIG['MAX_DELAY'])
        
        if retry_count > 0:
            print(f"Waiting {delay}s before retry attempt {retry_count}...")
        
        time.sleep(delay)

        # Call the API
        response = client.models.generate_content(
            model="gemini-3.1-pro-preview",
            contents=api_contents
        )
        
        return response.text
        
    except Exception as e:
        error_str = str(e)
        print(f" Error calling Google GenAI: {e}")
        
        # Parse retry delay from error message if available
        if "RESOURCE_EXHAUSTED" in error_str or "429" in error_str:
            import re
            retry_delay_match = re.search(r"'retryDelay': '(\d+)s'", error_str)
            if retry_delay_match:
                suggested_delay = int(retry_delay_match.group(1))
                print(f"API suggested waiting {suggested_delay}s for quota reset")
                # Use the suggested delay plus some buffer
                time.sleep(suggested_delay + 5)
        
        return None

class VLMJudgeEvaluator:
    """VLM-as-Judge Evaluation System - Supports multiple content types."""

    SUPPORTED_CONTENT_TYPES = ['paper', 'survey', 'textbook', 'blog']

    def __init__(self, output_folder: str = "vlm_judge_results"):
        """
        Initialize the VLM-as-Judge evaluation system.

        Args:
            output_folder: Output folder for evaluation results.
        """
        self.output_folder = Path(output_folder)
        self.output_folder.mkdir(exist_ok=True)

        self.scores_folder = self.output_folder / "individual_scores"
        self.comparisons_folder = self.output_folder / "pairwise_comparisons"
        self.summaries_folder = self.output_folder / "batch_summaries"
        self.visualizations_folder = self.output_folder / "visualizations"

        for folder in [self.scores_folder, self.comparisons_folder, self.summaries_folder, self.visualizations_folder]:
            folder.mkdir(exist_ok=True)
    
    def _get_content_type_context(self, content_type: str) -> Dict[str, str]:
        """Get evaluation context and criteria based on content type."""
        contexts = {
            'paper': {
                'content_name': 'research paper methodology',
                'content_description': 'detailed methodology description from a research paper',
                'evaluation_focus': 'The figure should accurately represent the research methodology, clearly showing the workflow, data flow, or system architecture described in the paper.',
                'audience': 'academic researchers and peers in the field',
                'complexity_level': 'high technical complexity with precise scientific terminology'
            },
            'survey': {
                'content_name': 'survey/review article content',
                'content_description': 'comprehensive review or survey content covering multiple approaches or methods',
                'evaluation_focus': 'The figure should provide a clear overview or taxonomy that helps readers understand relationships between different approaches, methods, or concepts covered in the survey.',
                'audience': 'researchers seeking to understand the landscape of a field',
                'complexity_level': 'medium to high complexity with comprehensive coverage'
            },
            'textbook': {
                'content_name': 'educational textbook material',
                'content_description': 'educational content from a textbook chapter or section',
                'evaluation_focus': 'The figure should support learning objectives, making complex concepts accessible and easy to understand for students.',
                'audience': 'students and educators',
                'complexity_level': 'medium complexity with clear pedagogical structure'
            },
            'blog': {
                'content_name': 'blog article content',
                'content_description': 'informal blog post or article content',
                'evaluation_focus': 'The figure should engage readers and make the content more accessible, with emphasis on visual appeal and easy comprehension.',
                'audience': 'general readers and practitioners',
                'complexity_level': 'low to medium complexity with emphasis on accessibility'
            }
        }
        return contexts.get(content_type, contexts['paper'])
    
    def evaluate_single_figure(self, figure_path: str, figure_id: str = None,
                              content_text: Optional[str] = None, content_type: str = 'paper',
                              reference_figure_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """
        Evaluate a single academic figure using VLM scoring.

        Args:
            figure_path: Path to the image file.
            figure_id: Figure identifier (for anonymization).
            content_text: Academic content text (paper methodology, survey, textbook content, blog post, etc.).
            content_type: Content type, supports 'paper', 'survey', 'textbook', 'blog'.
            reference_figure_path: Reference figure path (original figure) for scoring comparison.

        Returns:
            Evaluation result dictionary.
        """
        if figure_id is None:
            figure_id = str(uuid.uuid4())[:8]

        if content_type not in self.SUPPORTED_CONTENT_TYPES:
            print(f"Unsupported content type: {content_type}. Using 'paper' as default.")
            content_type = 'paper'

        try:
            figure_image = Image.open(figure_path)

            reference_image = None
            if reference_figure_path:
                try:
                    reference_image = Image.open(reference_figure_path)
                    print(f"Loaded reference figure: {Path(reference_figure_path).name}")
                except Exception as e:
                    print(f"Failed to load reference figure: {e}")
                    reference_image = None

            type_context = self._get_content_type_context(content_type)

            content_context_prompt = ""
            content_fidelity_prompt = ""
            content_fidelity_json_template = ""

            if content_text:
                content_context_prompt = f"""
**{type_context['content_name'].title()} Context:**
You MUST use the following {type_context['content_description']} as the ground truth for what the figure should communicate.
The target audience is: {type_context['audience']}.
Expected complexity level: {type_context['complexity_level']}.

{type_context['evaluation_focus']}

---
{content_text}
---
"""
                content_fidelity_prompt = f"""

---
**Part 3: Content Fidelity (Faithfulness to the Source {content_type})**
*Only evaluate this part if source {content_type} text is provided.*

6.  **Accuracy:**
    - Does the figure faithfully represent all key components and relationships described in the source text?
7.  **Completeness:**
    - Are any critical elements from the source content missing or misrepresented?
8.  **Appropriateness to Audience:**
    - Is the figure's complexity, abstraction level, and style appropriate for the target audience ({type_context['audience']})?
"""
            
            reference_context_prompt = ""
            if reference_image:
                reference_context_prompt = f"""

**Reference Figure Context:**
You will be shown a REFERENCE FIGURE (labeled "Reference Figure") which represents the original, authentic figure for this {content_type}. This reference figure serves as the ground truth standard for comparison. Use this reference to guide your evaluation by considering:
- How well does the candidate figure capture the key visual elements of the reference?
- Does the candidate figure maintain the essential information structure while potentially improving visual design?
- How does the candidate figure's approach compare to the reference in terms of clarity and effectiveness?

Please note: The reference figure represents the original authentic visualization, while the candidate figure is a generated/redesigned version that should be evaluated both independently for its design quality AND in relation to how well it serves the same communicative purpose as the reference.

---
"""

            prompt = f"""{content_context_prompt}{reference_context_prompt}
You are a world-class Art Director and Visual Communication Expert for top-tier scientific publications. Your evaluation combines sophisticated aesthetic judgment with deep understanding of modern visual design principles. You recognize that excellence in scientific visualization requires both visual beauty and effective communication.

**Core Philosophy: Champion Modern Visual Excellence**
- **Distinguish between sophistication and clutter.** A sophisticated figure may use rich visual elements, multiple colors, detailed icons, and layered information - this is NOT clutter if well-organized. True clutter is disorganized, inconsistent, and poorly structured content.
- **Recognize modern design excellence.** The best contemporary figures combine visual appeal with information richness. They use professional color palettes, thoughtful typography, meaningful icons, and sophisticated layouts that engage the viewer while communicating clearly.
- **Value information-rich design.** A figure that successfully presents comprehensive information through well-designed visual elements should be highly valued, not penalized for complexity.
- **Use the full scoring range (1-10).** Reserve 9-10 for figures that demonstrate both modern visual sophistication AND clear communication. A basic, minimal figure should score 5-6, not 7-8.

**What Constitutes Modern Visual Excellence:**
- **Sophisticated Visual Language:** Professional use of colors, gradients, shadows, and modern typography that creates visual hierarchy and engagement
- **Meaningful Visual Elements:** Thoughtful use of icons, illustrations, and visual metaphors that enhance understanding beyond basic shapes and boxes
- **Information Architecture:** Well-organized presentation of complex information through visual structure, grouping, and flow
- **Design Craftsmanship:** Attention to visual details like consistent spacing, professional color coordination, and polished execution

**Evaluation Dimensions (Score 1-10, one decimal place):**

---
**Part 1: Visual Design Excellence (How sophisticated and appealing is the design?)**
*Evaluate modern visual design quality and professional execution.*

1.  **Aesthetic & Design Quality (ADQ):**
    - **Modern Visual Appeal:** Does the figure demonstrate contemporary design sophistication? Does it use professional color schemes, thoughtful gradients, appropriate shadows, and modern typography to create visual interest and hierarchy?
    - **Composition & Layout:** Is the layout well-structured with intentional design choices? Note that effective use of space may include rich visual content, not just whitespace.
    - **Design Innovation:** Does the figure go beyond basic boxes and arrows to use creative visual solutions, meaningful icons, and engaging presentation methods?

2.  **Visual Expressiveness (VE):**
    - **Rich Visual Language:** Are visual elements (icons, illustrations, graphics) professionally designed and semantically meaningful? Do they enhance understanding through visual metaphors and clear symbolism?
    - **Information Visualization:** How effectively does the figure transform abstract concepts into concrete visual representations? Does it make complex ideas accessible through visual design?
    - **Style Sophistication:** Does the overall visual style demonstrate professional design standards comparable to high-quality infographics and modern scientific publications?

3.  **Professional Polish (PP):**
    - **Execution Excellence:** Is every design element carefully crafted with attention to detail? This includes consistent styling, proper alignment, appropriate scaling, and cohesive visual treatment.
    - **Technical Proficiency:** Does the figure demonstrate mastery of design principles including color theory, typography, visual hierarchy, and layout composition?

---
**Part 2: Communication Effectiveness (How well does it communicate?)**
*Focus on clarity and information delivery while acknowledging that sophisticated visuals can enhance communication.*

4.  **Clarity:**
    - **Visual Organization:** Is complex information well-organized through visual structure? A sophisticated figure with many elements can still be clear if well-organized.
    - **Information Accessibility:** Can viewers quickly understand the main message and navigate detailed information? Good visual hierarchy supports complexity.

5.  **Logical Flow:**
    - **Narrative Structure:** Does the figure tell a clear story or present a logical progression? This can be achieved through various visual means including flow lines, visual grouping, and hierarchical presentation.
    - **Guided Exploration:** Does the visual design help viewers navigate and understand the content systematically, even when the content is information-rich?

{content_fidelity_prompt}
**Scoring Guidelines & Final Judgment:**
- **Focus on Accurate Dimensional Scores:** Provide precise scores (1-10, one decimal place) for each dimension based on the specific criteria.
- **Reward Visual Sophistication:** A figure with rich visual design, professional execution, and effective information presentation deserves high scores (8-10). Don't penalize sophistication if it's well-executed.
- **Penalize Amateur Design:** Basic figures with minimal visual design, poor color choices, or unprofessional execution should score lower (4-6), regardless of information completeness.
- **Information-Rich vs. Cluttered:** Distinguish between information-rich (good - uses visual design to organize complex content) and cluttered (bad - disorganized, inconsistent, poorly structured).
- **Modern vs. Traditional:** Value modern design approaches including creative use of color, sophisticated typography, meaningful icons, and visual innovation over traditional academic minimalism.

**Critical Evaluation Questions:**
1. Would this figure stand out positively in a modern scientific publication or high-quality presentation?
2. Does it demonstrate professional design skills beyond basic diagramming?
3. Would viewers find it visually engaging and easy to understand despite complexity?
4. Does it successfully transform abstract concepts into compelling visual narratives?

Use these questions to guide your dimensional assessments, ensuring each dimension receives an accurate score based on its specific criteria.

**Please use the following JSON template for your output:**
```json
{{
  "figure_id": "{figure_id}",
  "scores": {{
    "aesthetic_and_design_quality": {{"score": 8.5, "reasoning": "Demonstrates sophisticated modern design with professional color palette, thoughtful gradients, and contemporary typography that creates strong visual hierarchy and engagement."}},
    "visual_expressiveness": {{"score": 9.0, "reasoning": "Rich visual language with meaningful icons, professional illustrations, and effective visual metaphors that transform abstract concepts into accessible visual representations."}},
    "professional_polish": {{"score": 8.0, "reasoning": "Excellent execution with consistent styling, proper alignment, cohesive visual treatment, and mastery of design principles."}},
    "clarity": {{"score": 7.5, "reasoning": "Complex information is well-organized through sophisticated visual structure, making it accessible despite information richness."}},
    "logical_flow": {{"score": 8.0, "reasoning": "Clear narrative structure with effective visual grouping and hierarchical presentation that guides systematic exploration."}},
    "accuracy": {{"score": 8.5, "reasoning": "The figure accurately represents the main concepts from the {content_type}."}},
    "completeness": {{"score": 8.0, "reasoning": "The figure includes all critical elements from the {content_type}."}},
    "appropriateness": {{"score": 8.5, "reasoning": "The figure's sophisticated design and information richness are perfectly appropriate for {type_context['audience']}."}}

  }}
}}
```
"""
            
            print(f"Evaluating figure: {figure_id}")
            if reference_image:
                print(f"Using reference figure for comparison")

            llm_contents = [prompt]

            if reference_image:
                llm_contents.extend(["Reference Figure:", reference_image])

            llm_contents.extend(["Candidate Figure:", figure_image])

            for attempt in range(CONFIG['MAX_RETRIES']):
                response = call_google_genai_multimodal(llm_contents, retry_count=attempt)

                if response:
                    try:
                        import re
                        json_match = re.search(r'```json\s*(.*?)\s*```', response, re.DOTALL)
                        if json_match:
                            json_str = json_match.group(1)
                        else:
                            json_str = response.strip()

                        evaluation_result = json.loads(json_str)

                        if self._validate_evaluation_format(evaluation_result):
                            evaluation_result = self._recalculate_overall_score(evaluation_result)

                            print(f"Successfully evaluated figure {figure_id}")
                            evaluation_result['metadata'] = {
                                'figure_path': figure_path,
                                'evaluation_timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
                                'figure_id': figure_id
                            }
                            return evaluation_result
                        else:
                            print(f"Evaluation result format validation failed, retrying (Attempt {attempt + 1}/{CONFIG['MAX_RETRIES']})")

                    except json.JSONDecodeError as e:
                        print(f"JSON parsing failed: {e}, retrying (Attempt {attempt + 1}/{CONFIG['MAX_RETRIES']})")
                else:
                    print(f"API call failed, retrying (Attempt {attempt + 1}/{CONFIG['MAX_RETRIES']})")

            print(f"Failed to evaluate figure: {figure_path}")
            return None

        except Exception as e:
            print(f"Error during figure evaluation: {e}")
            return None

    def evaluate_figures_parallel(self, figure_paths: Dict[str, str],
                                 max_workers: int = None,
                                 content_text: Optional[str] = None,
                                 content_type: str = 'paper',
                                 reference_figure_path: Optional[str] = None) -> Dict[str, Optional[Dict[str, Any]]]:
        """
        Evaluate multiple figures in parallel.

        Args:
            figure_paths: Dictionary of figure paths, format: {figure_id: file_path}.
            max_workers: Maximum number of parallel worker threads.
            content_text: Academic content text.
            content_type: Content type, supports 'paper', 'survey', 'textbook', 'blog'.
            reference_figure_path: Reference figure path (original figure) for scoring comparison.

        Returns:
            Dictionary containing evaluation results for each figure.
        """
        if max_workers is None:
            max_workers = CONFIG['MAX_PARALLEL_WORKERS']

        print(f"Starting parallel evaluation for {len(figure_paths)} figures using {max_workers} workers...")

        def evaluate_single_wrapper(figure_info):
            """Wrapper function for single figure evaluation."""
            figure_id, figure_path = figure_info
            print(f"[{figure_id}] Starting evaluation: {figure_path}")
            result = self.evaluate_single_figure(figure_path, figure_id, content_text, content_type, reference_figure_path)
            if result:
                print(f"[{figure_id}] Evaluation successful")
            else:
                print(f"[{figure_id}] Evaluation failed")
            return figure_id, result

        results = {}

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_id = {
                executor.submit(evaluate_single_wrapper, (figure_id, path)): figure_id
                for figure_id, path in figure_paths.items()
            }

            for future in as_completed(future_to_id):
                try:
                    figure_id, evaluation_result = future.result()
                    results[figure_id] = evaluation_result
                except Exception as e:
                    figure_id = future_to_id[future]
                    print(f"[{figure_id}] Error during processing: {e}")
                    results[figure_id] = None

        successful_count = sum(1 for v in results.values() if v is not None)
        print(f"Parallel evaluation finished. Successfully processed {successful_count}/{len(figure_paths)} figures.")
        return results

    def pairwise_comparisons_parallel(self, comparison_tasks: List[Tuple[str, str, str]],
                                     max_workers: int = None,
                                     content_text: Optional[str] = None,
                                     content_type: str = 'paper') -> Dict[str, Optional[Dict[str, Any]]]:
        """
        Perform pairwise comparisons in parallel.

        Args:
            comparison_tasks: List of comparison tasks, format: [(figure1_path, figure2_path, comparison_id), ...].
            max_workers: Maximum number of parallel worker threads.
            content_text: Academic content text.
            content_type: Content type, supports 'paper', 'survey', 'textbook', 'blog'.

        Returns:
            Dictionary containing comparison results.
        """
        if max_workers is None:
            max_workers = CONFIG['MAX_PARALLEL_WORKERS']

        print(f"Starting parallel comparison for {len(comparison_tasks)} tasks using {max_workers} workers...")

        def comparison_wrapper(task):
            """Wrapper function for pairwise comparison."""
            figure1_path, figure2_path, comparison_id = task
            print(f"[{comparison_id}] Comparing: {Path(figure1_path).stem} vs {Path(figure2_path).stem}")
            result = self.pairwise_comparison(figure1_path, figure2_path, comparison_id, content_text, content_type)
            if result:
                print(f"[{comparison_id}] Comparison successful")
            else:
                print(f"[{comparison_id}] Comparison failed")
            return comparison_id, result

        results = {}

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_id = {
                executor.submit(comparison_wrapper, task): task[2]
                for task in comparison_tasks
            }

            for future in as_completed(future_to_id):
                try:
                    comparison_id, comparison_result = future.result()
                    results[comparison_id] = comparison_result
                except Exception as e:
                    comparison_id = future_to_id[future]
                    print(f"[{comparison_id}] Error during processing: {e}")
                    results[comparison_id] = None

        successful_count = sum(1 for v in results.values() if v is not None)
        print(f"Parallel comparison finished. Successfully processed {successful_count}/{len(comparison_tasks)} tasks.")
        return results

    def _list_images(self, folder: Path) -> List[Path]:
        """List all image files in a folder."""
        allowed = {'.png', '.jpg', '.jpeg', '.svg'}
        if not folder.exists():
            return []
        return [p for p in folder.iterdir() if p.suffix.lower() in allowed]

    def evaluate_generated_vs_reference(
        self,
        generated_dir: str,
        true_dir: str,
        reference_image_stem: Optional[str] = None,
        content_text: Optional[str] = None,
        content_type: str = 'paper'
    ) -> Dict[str, Any]:
        """
        Evaluate all generated figures against a reference figure and generate visualizations.

        Returns:
            Dictionary containing reference scores, generated figure scores, and visualization paths.
        """
        gen_dir = Path(generated_dir)
        true_dir = Path(true_dir)
        generated_images = self._list_images(gen_dir)
        true_images = self._list_images(true_dir)

        if not generated_images:
            return {'error': f'Generated figures directory is empty: {gen_dir}'}
        if not true_images:
            return {'error': f'True figures directory is empty: {true_dir}'}

        reference_path: Optional[Path] = None
        if reference_image_stem is not None:
            for p in true_images:
                if p.stem == reference_image_stem:
                    reference_path = p
                    break
        if reference_path is None:
            reference_path = true_images[0]

        
        all_figure_paths = {f'ref_{reference_path.stem}': str(reference_path)}
        for img in generated_images:
            all_figure_paths[f'gen_{img.stem}'] = str(img)
        
        print(f"Starting parallel evaluation for {len(all_figure_paths)} figures (1 reference + {len(generated_images)} generated)...")
        
        
        parallel_results = self.evaluate_figures_parallel(all_figure_paths, content_text=content_text, content_type=content_type)
        
        
        ref_key = f'ref_{reference_path.stem}'
        ref_eval = parallel_results.get(ref_key)
        if ref_eval:
            
            out = self.scores_folder / f"ref_{reference_path.stem}_evaluation.json"
            with open(out, 'w', encoding='utf-8') as f:
                json.dump(ref_eval, f, ensure_ascii=False, indent=2)
        
        
        gen_results: List[Dict[str, Any]] = []
        for img in generated_images:
            gen_key = f'gen_{img.stem}'
            res = parallel_results.get(gen_key)
            entry: Dict[str, Any] = {'name': img.stem, 'figure_path': str(img)}
            if res:
                entry['evaluation'] = res
                
                out = self.scores_folder / f"gen_{img.stem}_evaluation.json"
                with open(out, 'w', encoding='utf-8') as f:
                    json.dump(res, f, ensure_ascii=False, indent=2)
            else:
                entry['error'] = 'Evaluation failed'
            gen_results.append(entry)

        
        viz_overall = self._visualize_overall_scores(gen_results, ref_eval, reference_path.stem)
        viz_heatmap = self._visualize_dimension_heatmap(gen_results, ref_eval, reference_path.stem)

        summary = {
            'reference': {
                'name': reference_path.stem,
                'figure_path': str(reference_path),
                'evaluation': ref_eval
            },
            'generated': gen_results,
            'visualizations': {
                'overall_scores': viz_overall,
                'dimension_heatmap': viz_heatmap
            }
        }

        
        out_summary = self.summaries_folder / f"gen_vs_ref_summary_{reference_path.stem}.json"
        with open(out_summary, 'w', encoding='utf-8') as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

        return summary

    def _visualize_overall_scores(self, gen_results: List[Dict[str, Any]], ref_eval: Optional[Dict[str, Any]], ref_name: str) -> Optional[str]:
        """Bar chart: Compare overall_score of generated figures with reference figure baseline."""
        try:
            
            sorted_results = sorted(
                [item for item in gen_results if 'evaluation' in item and item['evaluation']],
                key=lambda x: x['evaluation'].get('overall_score', 0),
                reverse=True
            )
            
            names: List[str] = [item['name'] for item in sorted_results]
            scores: List[float] = [float(item['evaluation'].get('overall_score', 0)) for item in sorted_results]

            plt.figure(figsize=(max(8, len(names) * 0.9), 5))
            bars = plt.bar(range(len(names)), scores, color="#4c78a8")
            plt.xticks(range(len(names)), names, rotation=45, ha='right')
            plt.ylabel('Overall Score (1-10)')
            plt.title('Generated Figures Overall Scores vs Reference')

            
            if ref_eval and isinstance(ref_eval.get('overall_score', None), (int, float)):
                ref_score = float(ref_eval['overall_score'])
                plt.axhline(ref_score, color='#f58518', linestyle='--', label=f'Reference {ref_name}: {ref_score:.2f}')
                plt.legend()

            
            for bar, val in zip(bars, scores):
                plt.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.05, f'{val:.2f}',
                         ha='center', va='bottom', fontsize=8)

            plt.tight_layout()
            out_path = self.visualizations_folder / f"overall_scores_vs_{ref_name}.png"
            plt.savefig(out_path, dpi=150)
            plt.close()
            return str(out_path)
        except Exception as e:
            print(f" Failed to generate overall scores visualization: {e}")
            return None

    def _visualize_dimension_heatmap(self, gen_results: List[Dict[str, Any]], ref_eval: Optional[Dict[str, Any]], ref_name: str) -> Optional[str]:
        """Heatmap: Dimension scores for generated figures with reference figure row at top."""
        try:
            dimensions = [
                'aesthetic_and_design_quality', 'visual_expressiveness', 'professional_polish', 
                'clarity', 'logical_flow', 'content_fidelity'
            ]
            dim_labels = ['Aesthetics', 'Expressiveness', 'Polish', 'Clarity', 'Logic', 'Fidelity']

            
            sorted_gen_results = sorted(
                [res for res in gen_results if 'evaluation' in res and res['evaluation']],
                key=lambda x: x['evaluation'].get('overall_score', 0),
                reverse=True
            )
            
            rows: List[str] = []
            data: List[List[float]] = []

            
            if ref_eval and 'scores' in ref_eval:
                rows.append(f"REF:{ref_name}")
                data.append([float(ref_eval['scores'].get(d, {}).get('score', 0.0)) for d in dimensions])

            
            for item in sorted_gen_results:
                row_name = item['name']
                rows.append(row_name)
                if 'evaluation' in item and 'scores' in item['evaluation']:
                    scores_data = item['evaluation']['scores']
                    scores = [float(scores_data.get(d, {}).get('score', 0.0)) for d in dimensions]
                else:
                    scores = [0.0] * len(dimensions)
                data.append(scores)

            
            import numpy as np
            arr = np.array(data)
            plt.figure(figsize=(len(dimensions) * 1.2, max(6, len(rows) * 0.5)))
            im = plt.imshow(arr, cmap='YlOrRd', aspect='auto', vmin=0, vmax=10)
            plt.colorbar(im, fraction=0.046, pad=0.04, label='Score (1-10)')
            plt.xticks(range(len(dimensions)), dim_labels, rotation=45, ha='right')
            plt.yticks(range(len(rows)), rows)
            plt.title('Dimension Scores Heatmap (Generated vs Reference)')

            
            for i in range(arr.shape[0]):
                for j in range(arr.shape[1]):
                    plt.text(j, i, f"{arr[i, j]:.1f}", ha='center', va='center', fontsize=7, color='black')

            plt.tight_layout()
            out_path = self.visualizations_folder / f"dimension_heatmap_vs_{ref_name}.png"
            plt.savefig(out_path, dpi=150)
            plt.close()
            return str(out_path)
        except Exception as e:
            print(f" Failed to generate dimension heatmap: {e}")
            return None
    
    def _recalculate_overall_score(self, evaluation_result: Dict) -> Dict:
        """Recalculate overall_score as the average of all dimension scores."""
        try:
            scores = evaluation_result.get('scores', {})
            if not scores:
                print(" No scores found for recalculation, cannot calculate overall_score")
                return evaluation_result
            
            
            dimension_scores = []
            for dimension, score_data in scores.items():
                if isinstance(score_data, dict) and 'score' in score_data:
                    score = score_data['score']
                    if isinstance(score, (int, float)):
                        dimension_scores.append(float(score))
                        print(f"   {dimension}: {score}")
            
            if dimension_scores:
                
                calculated_overall_score = sum(dimension_scores) / len(dimension_scores)
                
                
                evaluation_result['overall_score'] = round(calculated_overall_score, 2)
                
                print(f" Overall score calculated:")
                print(f"   Average of {len(dimension_scores)} dimensions: {evaluation_result['overall_score']}")
            else:
                print(" No valid dimension scores found for calculation")
                
                evaluation_result['overall_score'] = 0.0
            
            return evaluation_result
            
        except Exception as e:
            print(f" Error calculating overall_score: {e}, setting to 0.0")
            evaluation_result['overall_score'] = 0.0
            return evaluation_result
    
    def _validate_evaluation_format(self, data: Dict) -> bool:
        """Validate evaluation result format."""
        try:
            
            required_fields = ['scores']
            for field in required_fields:
                if field not in data:
                    print(f" Missing required field: {field}")
                    return False
            
            
            required_dimensions = [
                'aesthetic_and_design_quality', 'visual_expressiveness', 'professional_polish', 'clarity', 'logical_flow'
            ]
            
            
            
            
            all_dimensions = list(data.get('scores', {}).keys())
            if 'content_fidelity' in all_dimensions:
                required_dimensions.append('content_fidelity')
            
            for dimension in required_dimensions:
                if dimension not in data['scores']:
                    print(f" Missing scoring dimension: {dimension}")
                    return False
                
                score_data = data['scores'][dimension]
                if 'score' not in score_data or 'reasoning' not in score_data:
                    print(f" Dimension {dimension} is missing a score or reasoning")
                    return False
                
                
                score = score_data['score']
                if not isinstance(score, (int, float)) or score < 1 or score > 10:
                    print(f" Score for dimension {dimension} is out of range: {score}")
                    return False
            
            return True
            
        except Exception as e:
            print(f" Error validating evaluation format: {e}")
            return False
    
    def pairwise_comparison(self, figure1_path: str, figure2_path: str,
                           comparison_id: str = None, content_text: Optional[str] = None,
                           content_type: str = 'paper') -> Optional[Dict[str, Any]]:
        """
        Perform anonymous pairwise comparison of two figures.

        Args:
            figure1_path: Path to first figure.
            figure2_path: Path to second figure.
            comparison_id: Comparison identifier.
            content_text: Academic content text.
            content_type: Content type, supports 'paper', 'survey', 'textbook', 'blog'.

        Returns:
            Comparison result dictionary.
        """
        if comparison_id is None:
            comparison_id = str(uuid.uuid4())[:8]
        
        
        if content_type not in self.SUPPORTED_CONTENT_TYPES:
            print(f" Unsupported content type: {content_type}. Using 'paper' as default.")
            content_type = 'paper'
        
        try:
            
            figure1 = Image.open(figure1_path)
            figure2 = Image.open(figure2_path)
            
            
            type_context = self._get_content_type_context(content_type)
            
            
            if random.choice([True, False]):
                img_a, img_b = figure1, figure2
                path_a, path_b = figure1_path, figure2_path
                order = "original"
            else:
                img_a, img_b = figure2, figure1
                path_a, path_b = figure2_path, figure1_path
                order = "swapped"
            
            
            content_context_prompt = ""
            content_fidelity_prompt = ""
            content_fidelity_json_template = ""
            
            if content_text:
                content_context_prompt = f"""
**{type_context['content_name'].title()} Context:**
You MUST use the following {type_context['content_description']} as the ground truth for what the figures should communicate.
The target audience is: {type_context['audience']}.
Expected complexity level: {type_context['complexity_level']}.

{type_context['evaluation_focus']}

---
{content_text}
---
"""
                content_fidelity_prompt = f"""
7.  **Content Fidelity (CF):**
    - Which figure is more faithful to the source {content_type} text, accurately representing all key components without critical omissions?
    - Which figure is more appropriate for the target audience ({type_context['audience']})?
"""
                content_fidelity_json_template = f'    "content_fidelity": {{"winner": "A", "reasoning": "Figure A more accurately represents the key concepts from the {content_type} and is better suited for {type_context["audience"]}."}},'

            
            prompt = f"""{content_context_prompt}
You are a world-class Art Director and Visual Communication Expert for top-tier scientific publications. Your judgment combines sophisticated aesthetic taste with deep understanding of modern visual design principles. You must decide which figure demonstrates superior visual design and communication effectiveness.

**Core Philosophy: Recognize Modern Visual Excellence**
- **Value sophisticated design over minimalism.** A well-executed figure with rich visual elements, professional color usage, meaningful icons, and thoughtful composition is superior to a basic, minimal figure, even if the minimal figure is "cleaner."
- **Distinguish sophistication from clutter.** True sophistication uses visual complexity purposefully to enhance communication. Clutter is disorganized and inconsistent. A figure with many well-designed elements is sophisticated, not cluttered.
- **Champion professional execution.** Look for evidence of professional design skills: proper color theory application, typography mastery, visual hierarchy, consistent styling, and polished execution.
- **Reward visual innovation.** Figures that go beyond basic boxes and arrows to use creative visual solutions, meaningful metaphors, and engaging presentation should be strongly preferred.

**Modern Design Superiority Indicators:**
- **Visual Sophistication:** Professional color palettes, gradients, shadows, contemporary typography, and thoughtful visual hierarchy
- **Rich Information Visualization:** Meaningful icons, illustrations, and visual metaphors that make abstract concepts concrete and accessible
- **Design Craftsmanship:** Attention to detail in spacing, alignment, color coordination, and overall visual harmony
- **Contemporary Aesthetics:** Modern visual language that would be appropriate for high-quality scientific publications and professional presentations

**Comparison Dimensions (Choose A, B, Both good, or Both bad for each):**

**Important: Selection Criteria**
- **A**: Choose A if Figure A is clearly superior to Figure B
- **B**: Choose B if Figure B is clearly superior to Figure A
- **Both good**: Choose this if BOTH figures demonstrate high quality and professional standards, making it difficult to declare a clear winner (both are publication-ready with only minor differences in style)
- **Both bad**: Choose this if BOTH figures have significant flaws or fail to meet professional standards (neither would be suitable for publication without major revisions)

---
**Part 1: Visual Design Excellence (Which demonstrates superior modern design?)**

1.  **Aesthetic & Design Quality (ADQ):** - **Highest Weight**
    - Which figure demonstrates more sophisticated visual design? Consider professional color usage, contemporary typography, thoughtful composition, and modern visual appeal.
    - Which figure would be more impressive in a high-quality scientific publication or professional presentation?
    - If both are professionally designed or both are poorly designed, choose "Both good" or "Both bad" accordingly.

2.  **Visual Expressiveness (VE):**
    - Which figure uses richer, more meaningful visual language? Look for professional icons, illustrations, visual metaphors, and creative design solutions that go beyond basic shapes.
    - Which figure better transforms abstract concepts into engaging visual representations?
    - If both excel or both fail at visual expressiveness, choose "Both good" or "Both bad" accordingly.

3.  **Professional Polish (PP):**
    - Which figure demonstrates superior design craftsmanship and technical proficiency? Consider consistency, attention to detail, proper use of design principles, and overall execution quality.
    - Which figure shows evidence of professional design skills rather than basic diagramming?
    - If both show professional polish or both lack it, choose "Both good" or "Both bad" accordingly.

---
**Part 2: Communication & Sophistication (Which is more effective and sophisticated?)**

4.  **Clarity:**
    - Which figure better organizes complex information through sophisticated visual structure? Remember that well-designed complexity can be clearer than oversimplified content.
    - Which figure makes information more accessible through thoughtful visual design?
    - If both are equally clear or both are confusing, choose "Both good" or "Both bad" accordingly.

5.  **Logical Flow:**
    - Which figure presents information with better visual narrative and guidance? This can be achieved through various sophisticated visual means.
    - Which figure demonstrates superior information architecture and visual hierarchy?
    - If both have excellent or poor logical flow, choose "Both good" or "Both bad" accordingly.

6.  **Information Sophistication:**
    - Which figure provides more comprehensive and well-presented information while maintaining visual appeal?
    - Which figure better balances information richness with visual accessibility?
    - If both balance information well or both fail to do so, choose "Both good" or "Both bad" accordingly.
{content_fidelity_prompt}
**Final Decision Guidelines:**
- **Choose A or B** when there is a clear winner that demonstrates superior modern visual design and professional execution.
- **Choose "Both good"** when BOTH figures meet professional publication standards and the differences are primarily stylistic preferences rather than quality differences.
- **Choose "Both bad"** when BOTH figures have significant deficiencies that would prevent publication without major revisions.
- **Value visual innovation and richness.** A figure with thoughtful use of colors, meaningful icons, professional typography, and sophisticated layout should win over basic diagrams.
- **Consider publication quality.** Which figure(s) would be appropriate for a high-quality scientific publication or professional presentation?
- **Be specific about design superiority or shared quality/deficiency.** Explain exactly why one figure wins, or why both are good/bad.

**Please use the following JSON template for your output:**
```json
{{
  "comparison_id": "{comparison_id}",
  "dimensional_comparison": {{
    "aesthetic_and_design_quality": {{"winner": "A or B or Both good or Both bad", "reasoning": "Explain your choice. For 'A'/'B': specify why one is superior. For 'Both good': explain why both meet professional standards. For 'Both bad': explain why both have significant flaws."}},
    "visual_expressiveness": {{"winner": "A or B or Both good or Both bad", "reasoning": "For 'A'/'B': explain superior visual language. For 'Both good': explain why both excel. For 'Both bad': explain why both fail."}},
    "professional_polish": {{"winner": "A or B or Both good or Both bad", "reasoning": "For 'A'/'B': explain superior craftsmanship. For 'Both good': explain why both are polished. For 'Both bad': explain why both lack polish."}},
    "clarity": {{"winner": "A or B or Both good or Both bad", "reasoning": "For 'A'/'B': explain superior clarity. For 'Both good': explain why both are clear. For 'Both bad': explain why both are confusing."}},
    "logical_flow": {{"winner": "A or B or Both good or Both bad", "reasoning": "For 'A'/'B': explain superior flow. For 'Both good': explain why both have excellent flow. For 'Both bad': explain why both lack proper flow."}},
    "information_sophistication": {{"winner": "A or B or Both good or Both bad", "reasoning": "For 'A'/'B': explain superior information balance. For 'Both good': explain why both balance well. For 'Both bad': explain why both fail to balance."}},
{content_fidelity_json_template}
  }},
  "final_decision": {{
    "winner": "A or B or Both good or Both bad",
    "confidence": "High or Medium or Low",
    "reasoning": "Provide detailed reasoning for your choice. If 'A' or 'B': explain why it's the clear winner. If 'Both good': explain why both figures meet professional publication standards with only stylistic differences. If 'Both bad': explain why both figures have significant deficiencies preventing publication."
  }}
}}
```

**Example Response for "A wins":**
```json
{{
  "comparison_id": "example_1",
  "dimensional_comparison": {{
    "aesthetic_and_design_quality": {{"winner": "A", "reasoning": "Figure A demonstrates sophisticated modern design with professional color palette, contemporary typography, and thoughtful visual hierarchy, while Figure B uses basic colors and minimal design elements."}},
    "visual_expressiveness": {{"winner": "A", "reasoning": "Figure A uses rich visual language with meaningful icons and professional illustrations; Figure B relies on simple shapes and basic arrows."}}
  }},
  "final_decision": {{
    "winner": "A",
    "confidence": "High",
    "reasoning": "Figure A is the clear winner due to its sophisticated modern design and professional execution."
  }}
}}
```

**Example Response for "Both good":**
```json
{{
  "comparison_id": "example_2",
  "dimensional_comparison": {{
    "aesthetic_and_design_quality": {{"winner": "Both good", "reasoning": "Both figures demonstrate professional color usage and contemporary design suitable for publication. Figure A uses a warmer palette while Figure B uses cooler tones, but both are equally sophisticated."}},
    "visual_expressiveness": {{"winner": "Both good", "reasoning": "Both figures effectively use icons and visual metaphors to communicate concepts. Figure A emphasizes flowcharts while Figure B emphasizes component diagrams, but both are equally expressive."}}
  }},
  "final_decision": {{
    "winner": "Both good",
    "confidence": "High",
    "reasoning": "Both figures meet professional publication standards with excellent design quality. The differences are primarily stylistic preferences rather than quality differences."
  }}
}}
```

**Example Response for "Both bad":**
```json
{{
  "comparison_id": "example_3",
  "dimensional_comparison": {{
    "aesthetic_and_design_quality": {{"winner": "Both bad", "reasoning": "Both figures use clashing colors and poor typography that would not be acceptable in professional publications. Neither demonstrates adequate visual design skills."}},
    "professional_polish": {{"winner": "Both bad", "reasoning": "Both figures have alignment issues, inconsistent styling, and poor attention to detail. Neither shows professional-level execution."}}
  }},
  "final_decision": {{
    "winner": "Both bad",
    "confidence": "High",
    "reasoning": "Both figures have significant design deficiencies that would require major revisions before publication. Neither meets minimum professional standards for scientific illustrations."
  }}
}}
```
"""
            
            print(f" Performing pairwise comparison: {comparison_id}")
            
            
            for attempt in range(CONFIG['MAX_RETRIES']):
                response = call_google_genai_multimodal([prompt, "Figure A:", img_a, "Figure B:", img_b], retry_count=attempt)
                
                if response:
                    try:
                        
                        import re
                        json_match = re.search(r'```json\s*(.*?)\s*```', response, re.DOTALL)
                        if json_match:
                            json_str = json_match.group(1)
                        else:
                            json_str = response.strip()
                        
                        comparison_result = json.loads(json_str)
                        
                        
                        if self._validate_comparison_format(comparison_result):
                            print(f" Successfully completed pairwise comparison {comparison_id}")
                            
                            
                            comparison_result['metadata'] = {
                                'figure1_path': figure1_path,
                                'figure2_path': figure2_path,
                                'presentation_order': order,
                                'actual_figure_a': path_a,
                                'actual_figure_b': path_b,
                                'comparison_timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
                                'comparison_id': comparison_id
                            }
                            
                            return comparison_result
                        else:
                            print(f" Comparison result format validation failed, retrying (Attempt {attempt + 1}/{CONFIG['MAX_RETRIES']})")
                    
                    except json.JSONDecodeError as e:
                        print(f" JSON parsing failed: {e}, retrying (Attempt {attempt + 1}/{CONFIG['MAX_RETRIES']})")
                else:
                    print(f" API call failed, retrying (Attempt {attempt + 1}/{CONFIG['MAX_RETRIES']})")
            
            print(f" Pairwise comparison failed: {figure1_path} vs {figure2_path}")
            return None
            
        except Exception as e:
            print(f" Error during pairwise comparison: {e}")
            return None
    
    def _validate_comparison_format(self, data: Dict) -> bool:
        """Validate comparison result format."""
        try:
            
            required_fields = ['dimensional_comparison', 'final_decision']
            for field in required_fields:
                if field not in data:
                    print(f" Missing required field: {field}")
                    return False
            
            
            required_dimensions = [
                'aesthetic_and_design_quality', 'visual_expressiveness', 'professional_polish', 'clarity', 'logical_flow', 'information_sophistication'
            ]

            
            all_dimensions = list(data.get('dimensional_comparison', {}).keys())
            if 'content_fidelity' in all_dimensions:
                required_dimensions.append('content_fidelity')
            
            for dimension in required_dimensions:
                if dimension not in data['dimensional_comparison']:
                    print(f" Missing comparison dimension: {dimension}")
                    return False
                
                comparison_data = data['dimensional_comparison'][dimension]
                if 'winner' not in comparison_data or 'reasoning' not in comparison_data:
                    print(f" Dimension {dimension} is missing a winner or reasoning")
                    return False
                
                
                winner = comparison_data['winner']
                if winner not in ['A', 'B', 'Both good', 'Both bad']:
                    print(f" Invalid winner selection for dimension {dimension}: {winner}. Must be one of: A, B, Both good, Both bad")
                    return False
            
            
            final_decision = data['final_decision']
            if 'winner' not in final_decision or 'confidence' not in final_decision or 'reasoning' not in final_decision:
                print(" `final_decision` is missing required fields")
                return False
            
            
            return True
            
        except Exception as e:
            print(f" Error validating comparison format: {e}")
            return False
    
    def batch_evaluate_individual(self, figure_folder: str, figure_type: str = "generated",
                                 content_text: Optional[str] = None, content_type: str = 'paper') -> Dict[str, Any]:
        """
        Batch evaluate individual figure scores.
        
        Args:
            figure_folder: Path to figures folder.
            figure_type: Figure type identifier.
            content_text: Academic content text.
            content_type: Content type, supports 'paper', 'survey', 'textbook', 'blog'.
            
        Returns:
            Batch evaluation results.
        """
        figure_folder = Path(figure_folder)
        
        
        image_extensions = ['*.png', '*.jpg', '*.jpeg', '*.svg']
        figure_files = []
        for ext in image_extensions:
            figure_files.extend(figure_folder.glob(ext))
        
        if not figure_files:
            print(" No image files found.")
            return {}
        
        print(f" Found {len(figure_files)} image files to evaluate.")
        
        
        figure_paths = {}
        for figure_file in figure_files:
            figure_name = figure_file.stem
            figure_id = f"{figure_type}_{figure_name}"
            figure_paths[figure_id] = str(figure_file)
        
        print(f" Starting parallel evaluation for {len(figure_paths)} {figure_type} figures...")
        
        
        parallel_results = self.evaluate_figures_parallel(figure_paths, content_text=content_text, content_type=content_type)
        
        
        batch_results = {}
        successful_evaluations = 0
        
        for figure_file in figure_files:
            figure_name = figure_file.stem
            figure_id = f"{figure_type}_{figure_name}"
            
            result = parallel_results.get(figure_id)
            if result:
                batch_results[figure_name] = result
                successful_evaluations += 1
                
                score_file = self.scores_folder / f"{figure_id}_evaluation.json"
                with open(score_file, 'w', encoding='utf-8') as f:
                    json.dump(result, f, ensure_ascii=False, indent=2)
            else:
                batch_results[figure_name] = {'error': 'Evaluation failed'}
        
        
        summary = self._generate_individual_summary(batch_results, figure_type)
        batch_results['_summary'] = summary
        
        
        batch_file = self.summaries_folder / f"{figure_type}_individual_evaluation.json"
        with open(batch_file, 'w', encoding='utf-8') as f:
            json.dump(batch_results, f, ensure_ascii=False, indent=2)
        
        print(f"\n Batch evaluation for {figure_type} complete!")
        print(f" Successfully evaluated: {successful_evaluations}/{len(figure_files)}")
        print(f" Results saved to: {batch_file}")
        
        return batch_results
    
    def batch_pairwise_comparison(self, generated_folder: str, true_folder: str, 
                                 num_rounds: int = None, content_text: Optional[str] = None,
                                 content_type: str = 'paper') -> Dict[str, Any]:
        """
        Batch pairwise comparison evaluation.
        
        Args:
            generated_folder: Generated figures folder.
            true_folder: Ground truth figures folder.
            num_rounds: Number of comparison rounds per pair.
            content_text: Academic content text.
            content_type: Content type, supports 'paper', 'survey', 'textbook', 'blog'.
            
        Returns:
            Batch comparison results.
        """
        if num_rounds is None:
            num_rounds = CONFIG['EVALUATION_ROUNDS']
        
        generated_folder = Path(generated_folder)
        true_folder = Path(true_folder)
        
        
        image_extensions = ['.png', '.jpg', '.jpeg', '.svg']
        pairs = []
        
        for gen_file in generated_folder.iterdir():
            if gen_file.suffix.lower() in image_extensions:
                
                for ext in image_extensions:
                    true_file = true_folder / f"{gen_file.stem}{ext}"
                    if true_file.exists():
                        pairs.append((str(gen_file), str(true_file), gen_file.stem))
                        break
        
        if not pairs:
            print(" No matching pairs of images found.")
            return {}
        
        print(f" Found {len(pairs)} pairs to compare, with {num_rounds} evaluation rounds for each.")
        
        
        comparison_tasks = []
        for gen_path, true_path, paper_name in pairs:
            for round_num in range(num_rounds):
                comparison_id = f"{paper_name}_round_{round_num + 1}"
                comparison_tasks.append((gen_path, true_path, comparison_id))
        
        print(f" Starting parallel pairwise comparison for {len(comparison_tasks)} tasks...")
        
        
        parallel_results = self.pairwise_comparisons_parallel(comparison_tasks, content_text=content_text, content_type=content_type)
        
        
        comparison_results = {}
        successful_comparisons = 0
        
        for gen_path, true_path, paper_name in pairs:
            paper_results = []
            paper_has_success = False
            
            for round_num in range(num_rounds):
                comparison_id = f"{paper_name}_round_{round_num + 1}"
                result = parallel_results.get(comparison_id)
                
                if result:
                    paper_results.append(result)
                    paper_has_success = True
                    
                    
                    comp_file = self.comparisons_folder / f"{comparison_id}_comparison.json"
                    with open(comp_file, 'w', encoding='utf-8') as f:
                        json.dump(result, f, ensure_ascii=False, indent=2)
                else:
                    paper_results.append({'error': f'Round {round_num + 1} comparison failed'})
            
            if paper_results:
                comparison_results[paper_name] = paper_results
                if paper_has_success:
                    successful_comparisons += 1
        
        
        summary = self._generate_comparison_summary(comparison_results)
        comparison_results['_summary'] = summary
        
        
        batch_file = self.summaries_folder / "pairwise_comparison_results.json"
        with open(batch_file, 'w', encoding='utf-8') as f:
            json.dump(comparison_results, f, ensure_ascii=False, indent=2)
        
        print(f"\n Batch pairwise comparison complete!")
        print(f" Successfully compared: {successful_comparisons}/{len(pairs)}")
        print(f" Results saved to: {batch_file}")
        
        return comparison_results
    
    def _generate_individual_summary(self, batch_results: Dict, figure_type: str) -> Dict[str, Any]:
        """Generate summary for single figure evaluation."""
        successful_evaluations = []
        dimension_scores = {
            'aesthetic_and_design_quality': [],
            'visual_expressiveness': [],
            'professional_polish': [],
            'clarity': [],
            'logical_flow': [],
            'content_fidelity': []
        }
        overall_scores = []
        
        for paper_name, result in batch_results.items():
            if paper_name.startswith('_'):
                continue
                
            if 'error' not in result and 'scores' in result:
                successful_evaluations.append(paper_name)
                
                
                if 'scores' in result:
                    for dimension in dimension_scores.keys():
                        if dimension in result['scores']:
                            score = result['scores'][dimension].get('score', 0)
                            dimension_scores[dimension].append(score)
                
                
                if 'overall_score' in result:
                    overall_scores.append(result['overall_score'])
        
        
        summary = {
            'figure_type': figure_type,
            'total_figures': len([k for k in batch_results.keys() if not k.startswith('_')]),
            'successful_evaluations': len(successful_evaluations),
            'overall_statistics': {
                'count': len(overall_scores),
                'mean': sum(overall_scores) / len(overall_scores) if overall_scores else 0,
                'min': min(overall_scores) if overall_scores else 0,
                'max': max(overall_scores) if overall_scores else 0,
                'scores': overall_scores
            },
            'dimension_statistics': {}
        }
        
        
        for dimension, scores in dimension_scores.items():
            if scores:
                summary['dimension_statistics'][dimension] = {
                    'count': len(scores),
                    'mean': sum(scores) / len(scores),
                    'min': min(scores),
                    'max': max(scores),
                    'scores': scores
                }
        
        return summary
    
    def _generate_comparison_summary(self, comparison_results: Dict) -> Dict[str, Any]:
        """Generate summary for pairwise comparison."""
        total_papers = len([k for k in comparison_results.keys() if not k.startswith('_')])
        successful_papers = 0
        
        
        generated_wins = 0
        true_wins = 0
        both_good = 0
        both_bad = 0
        total_comparisons = 0
        
        
        dimension_stats = {
            'aesthetic_and_design_quality': {'generated': 0, 'true': 0, 'both_good': 0, 'both_bad': 0},
            'visual_expressiveness': {'generated': 0, 'true': 0, 'both_good': 0, 'both_bad': 0},
            'professional_polish': {'generated': 0, 'true': 0, 'both_good': 0, 'both_bad': 0},
            'clarity': {'generated': 0, 'true': 0, 'both_good': 0, 'both_bad': 0},
            'logical_flow': {'generated': 0, 'true': 0, 'both_good': 0, 'both_bad': 0},
            'content_fidelity': {'generated': 0, 'true': 0, 'both_good': 0, 'both_bad': 0}
        }
        
        for paper_name, paper_results in comparison_results.items():
            if paper_name.startswith('_'):
                continue
            
            paper_has_success = False
            for result in paper_results:
                if 'error' not in result:
                    paper_has_success = True
                    total_comparisons += 1
                    
                    
                    overall_winner = result.get('final_decision', {}).get('winner', '')
                    metadata = result.get('metadata', {})
                    order = metadata.get('presentation_order', 'original')
                    
                    
                    if overall_winner == 'A':
                        if order == 'original':
                            generated_wins += 1
                        else:
                            true_wins += 1
                    elif overall_winner == 'B':
                        if order == 'original':
                            true_wins += 1
                        else:
                            generated_wins += 1
                    elif overall_winner == 'Both good':
                        both_good += 1
                    elif overall_winner == 'Both bad':
                        both_bad += 1
                    
                    
                    dimensional_comparison = result.get('dimensional_comparison', {})
                    for dimension, comparison_data in dimensional_comparison.items():
                        if dimension in dimension_stats:
                            winner = comparison_data.get('winner', '')
                            if winner == 'A':
                                if order == 'original':
                                    dimension_stats[dimension]['generated'] += 1
                                else:
                                    dimension_stats[dimension]['true'] += 1
                            elif winner == 'B':
                                if order == 'original':
                                    dimension_stats[dimension]['true'] += 1
                                else:
                                    dimension_stats[dimension]['generated'] += 1
                            elif winner == 'Both good':
                                dimension_stats[dimension]['both_good'] += 1
                            elif winner == 'Both bad':
                                dimension_stats[dimension]['both_bad'] += 1
            
            if paper_has_success:
                successful_papers += 1
        
        
        summary = {
            'total_papers': total_papers,
            'successful_papers': successful_papers,
            'total_comparisons': total_comparisons,
            'overall_win_rate': {
                'generated_wins': generated_wins,
                'true_wins': true_wins,
                'both_good': both_good,
                'both_bad': both_bad,
                'generated_win_rate': generated_wins / total_comparisons if total_comparisons > 0 else 0,
                'true_win_rate': true_wins / total_comparisons if total_comparisons > 0 else 0,
                'both_good_rate': both_good / total_comparisons if total_comparisons > 0 else 0,
                'both_bad_rate': both_bad / total_comparisons if total_comparisons > 0 else 0
            },
            'dimension_win_rates': {}
        }
        
        
        for dimension, stats in dimension_stats.items():
            total_dim = stats['generated'] + stats['true'] + stats['both_good'] + stats['both_bad']
            if total_dim > 0:
                summary['dimension_win_rates'][dimension] = {
                    'generated_wins': stats['generated'],
                    'true_wins': stats['true'],
                    'both_good': stats['both_good'],
                    'both_bad': stats['both_bad'],
                    'generated_win_rate': stats['generated'] / total_dim,
                    'true_win_rate': stats['true'] / total_dim,
                    'both_good_rate': stats['both_good'] / total_dim,
                    'both_bad_rate': stats['both_bad'] / total_dim
                }
        
        return summary

def main():
    """Main function example."""
    
    evaluator = VLMJudgeEvaluator(output_folder="vlm_judge_results")
    
    print(" VLM-as-Judge Evaluation System - Parallel Processing Version")
    print("=" * 50)
    
    
    
    content_type = 'paper'
    content_paths = {
        'paper': "./vlm_evaluation_data/paper/paper.md",
        'survey': "./vlm_evaluation_data/survey/survey.md", 
        'textbook': "./vlm_evaluation_data/textbook/textbook.md",
        'blog': "./vlm_evaluation_data/blog/blog.md"
    }
    
    content_path = Path(content_paths.get(content_type, content_paths['paper']))
    content_text = None
    if content_path.exists():
        try:
            with open(content_path, 'r', encoding='utf-8') as f:
                content_text = f.read()
            print(f" Successfully loaded {content_type} content from: {content_path}")
        except Exception as e:
            print(f" Could not read {content_type} content file: {e}")
    else:
        print(f"ℹ {content_type.title()} content file not found at: {content_path}. Proceeding without it.")

    # Example: Single figure evaluation
    # result = evaluator.evaluate_single_figure(
    #     figure_path="./figures/sample_figure.png",
    #     figure_id="sample_001",
    #     content_text=content_text,
    #     content_type=content_type
    # )
    
    # Example: Parallel multi-figure evaluation (recommended)
    # figure_paths = {
    #     "gen_figure1": "./generated_figures/figure1.png",
    #     "gen_figure2": "./generated_figures/figure2.png",
    #     "ref_figure": "./true_figures/reference.png"
    # }
    # parallel_results = evaluator.evaluate_figures_parallel(
    #     figure_paths, content_text=content_text, content_type=content_type
    # )
    
    # Example: Batch single figure evaluation (parallel)
    print("\n Executing Batch Individual Evaluation (Parallel)...")
    
    # Evaluate generated figures
    # gen_results = evaluator.batch_evaluate_individual(
    #     figure_folder="./generated_figures",
    #     figure_type="generated",
    #     content_text=content_text,
    #     content_type=content_type
    # )
    
    # Evaluate ground truth figures
    # true_results = evaluator.batch_evaluate_individual(
    #     figure_folder="./true_figures", 
    #     figure_type="true",
    #     content_text=content_text,
    #     content_type=content_type
    # )
    
    # Example: All generated vs reference evaluation (recommended for quality comparison)
    print(f"\n Executing Generated vs. Reference Evaluation for {content_type.upper()}...")
    comparison_result = evaluator.evaluate_generated_vs_reference(
        generated_dir="./vlm_evaluation_data/generated_figures",
        true_dir="./vlm_evaluation_data/true_figures",
        reference_image_stem=None,
        content_text=content_text,
        content_type=content_type
    )
    
    # Example: Batch pairwise comparison (parallel)
    # print(f"\n Executing Batch Pairwise Comparison (Parallel) for {content_type.upper()}...")
    # comparison_results = evaluator.batch_pairwise_comparison(
    #     generated_folder="./vlm_evaluation_data/generated_figures",
    #     true_folder="./vlm_evaluation_data/true_figures",
    #     num_rounds=3,
    #     content_text=content_text,
    #     content_type=content_type
    # )
    
    print("\n VLM-as-judge evaluation complete!")
    print(f"\nEnhanced Multi-Content-Type Features for {content_type.upper()}:")
    print("- Support for Paper, Survey, Textbook, and Blog content types")
    print("- Content-aware evaluation criteria and prompts")
    print("- Target audience-specific assessments")
    print("- Parallel single-figure evaluation")
    print("- Parallel pairwise comparison") 
    print("- Concurrent processing of multiple figures")
    print("- Significantly improved evaluation speed")

if __name__ == "__main__":
    main()
