# Citation And Attribution

This page explains how we hope people cite and acknowledge AutoFigure.

This document is intentionally gentle:

- it is a request for fair academic attribution
- it is not an extra restriction added to the software license
- it is not legal advice

## Short version

If AutoFigure materially helps a paper, report, benchmark write-up, demo, or public figure artifact, please:

1. cite the AutoFigure paper
2. disclose meaningful AI assistance honestly
3. avoid presenting AI-generated figures as fully manual if that would mislead readers

If you only used AutoFigure in a minor operational way, such as launching a local script, browsing files, or testing a setup, citation is usually not necessary.

## When we strongly encourage citation

Citation is strongly encouraged when AutoFigure materially contributes to work such as:

- generating publication figures from text descriptions
- extracting methodology from papers and producing draft figures
- iterative figure refinement or evaluation that meaningfully shapes a public artifact
- benchmarks, demos, or case studies that materially depend on AutoFigure outputs

The practical rule is simple:

- if AutoFigure changed the substance, speed, or shape of the published figure or research artifact in a meaningful way, please cite it

## When citation is usually not necessary

Citation is usually unnecessary when AutoFigure was used only as:

- a local launcher
- a terminal convenience layer
- a setup helper without material figure or research contribution
- a one-off operational utility

## Preferred citation

Paper link:

- `https://openreview.net/forum?id=5N3z9JQJKq`

BibTeX:

```bibtex
@inproceedings{
zhu2026autofigure,
title={AutoFigure: Generating and Refining Publication-Ready Scientific Illustrations},
author={Minjun Zhu and Zhen Lin and Yixuan Weng and Panzhong Lu and Qiujie Xie and Yifan Wei and Sifan Liu and Qiyao Sun and Yue Zhang},
booktitle={The Fourteenth International Conference on Learning Representations},
year={2026},
url={https://openreview.net/forum?id=5N3z9JQJKq}
}
```

## Suggested acknowledgment text

If AutoFigure materially assisted the project, a short acknowledgment like the following is usually enough:

```text
We used AutoFigure to assist parts of the figure-generation workflow, including selected drafting, refinement, and/or evaluation of scientific illustrations. Final scientific claims, reported results, and publication decisions remain the responsibility of the human authors.
```

You can shorten or adapt this wording to match venue norms.

## AI assistance disclosure

We strongly encourage clear disclosure when AutoFigure contributed to:

- figure generation
- figure drafting or refinement
- prompt design for published visuals
- benchmark or demo outputs that showcase generated figures

The disclosure does not need to overstate use.
It should simply help readers understand where meaningful AI assistance existed.

## FigureBench note

If your public benchmark or dataset usage materially depends on FigureBench, we also encourage citing the FigureBench dataset record used in your work when applicable.

## Not a license condition

This citation guidance does not change the repository software license.

In particular:

- it is not a new license condition
- it does not terminate your software rights if you forget to cite
- it is a community and academic attribution request, not a software-usage gate

## Related files

- [CITATION.cff](./CITATION.cff)
- [TRADEMARK.md](./TRADEMARK.md)
- [README.md](./README.md)
