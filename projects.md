---
layout: page
title: Projects Experience
permalink: /projects/
---

## Projects Experience

### ReservoirPy: Lightweight Reservoir Numerical Simulator
*2026/03 - Present*

- Designed a modular, extensible reservoir numerical simulator supporting single-phase and two-phase (IMPES) flow
- Implemented ControlNet-style condition injection for permeability and well configuration
- Integrated CFL adaptive time-stepping, Peaceman well model, and geostatistical permeability field generation
- Full API documentation with MkDocs and mkdocstrings
- GitHub: [reservoirpy](https://github.com/ZhenglongChen-code/reservoirpy)

### FlowFormer: U-Net + Temporal Transformer for Reservoir Flow Prediction
*2026/04 - Present*

- Developed a deep learning surrogate model combining U-Net spatial modeling with Temporal Transformer for long-term reservoir flow field prediction
- Implemented dual decoder architecture to handle pressure and saturation separately, avoiding gradient interference
- Integrated ControlNet for condition injection (permeability and well configuration via ZeroConv)
- Extended to two-phase flow prediction with evaluation scripts
- GitHub: [FlowFormer](https://github.com/ZhenglongChen-code/FlowFormer)

### Adaptive Diffusion Research: Adaptive Time Sampling for Diffusion Models
*2026/03 - Present*

- Researched adaptive sampling strategies for diffusion models to accelerate generation while maintaining quality
- Built an experimental framework for evaluating adaptive time-step schedules in diffusion processes
- GitHub: [adaptive-diffusion-research](https://github.com/ZhenglongChen-code/adaptive-diffusion-research)

### MultiDoc2Train: Multi-modal Training Data Pipeline
*2026/04*

- Built a data processing pipeline converting HTML, PDF, and Markdown files to ModelScope JSONL training format
- Implemented quality filtering (length, special character ratio, repetition detection) and deduplication via MinHash
- Added language detection (Chinese/English) and multimodal support for MS-Swift
- GitHub: [MultiDoc2Train](https://github.com/ZhenglongChen-code/MultiDoc2Train)

### MindWeave for Obsidian: AI Knowledge Weaving Engine
*2026/04*

- Developed an Obsidian plugin that transforms scattered notes into structured Wiki knowledge bases using AI
- Supports multi-provider AI (OpenAI, Claude, Ollama) with smart inbox watching
- Auto-inserts bidirectional WikiLink syntax to connect concepts
- Released v1.0.0 via BRAT plugin ecosystem
- GitHub: [mindweave-for-obsidian](https://github.com/ZhenglongChen-code/mindweave-for-obsidian)

### Diffusion Model Implementation
*2026/03*

- Implemented DDPM, Improved DDPM, and Score SDE diffusion models from scratch
- Trained and evaluated on MNIST and CIFAR-10 datasets with configurable hyperparameters
- Built complete pipeline: forward process, reverse process, sampling, and visualization
- GitHub: [Diffusion](https://github.com/ZhenglongChen-code/Diffusion)

### Discrete PINN: Physics-Informed Neural Networks
*2024 - 2025*

- Explored discrete neural operator methods combined with physics-informed loss for PDE solving
- Implemented Discrete Neural Operator with Adaptive Sampling for transient Darcy flow
- Achieved 24.3% lower error than Residual Attention U-Net; adaptive sampling improved generalization by 35%
- GitHub: [discrete_pinn_kernel](https://github.com/ZhenglongChen-code/discrete_pinn_kernel), [Dis_pinn](https://github.com/ZhenglongChen-code/Dis_pinn)

### Generative Characterization of Oil-Gas Reservoirs, Chinese Academy of Science.
*2024/09 - 2025/03*

- Proposed a Discrete Neural Operator with Adaptive Sampling for transient Darcy flow surrogate modeling (paper under review, first author)
- Achieved 24.3% lower error than Residual Attention U-Net; adaptive sampling improved generalization by 35% over random sampling

### Generative Large Model for Hydrocarbon Sweet Spots, Chinese Academy of Science.
*2023/11 - 2024/03*

- Developed dataset augmentation via sublinear expectation theory to enable small-sample training
- Filed patent: *A Small-Sample Learning Method Based on Mathematical Expectation*

### Intelligent Surrogate Model for Imbalanced Data, Qingdao Soft Control Company.
*2023/09 - 2024/09*

- Addressed class imbalance in rubber-tire manufacturing via synthetic oversampling and sublinear-expectation-based noise modeling.
- Improved classification accuracy by 13% using logistic regression under maximal distribution
