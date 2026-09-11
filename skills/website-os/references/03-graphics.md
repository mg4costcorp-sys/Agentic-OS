# Graphics

Inventory every shipped graphic with its actual preview, file, aspect ratio and role. Include ownership, source and licence information where relevant. Graphics should explain this site's visual world, not show an unrelated moodboard.

Use supplied assets first. For a product with a mascot, create a cast/model reference before generating repeated scenes and pass that reference into later generations. For a restrained software interface, typography and functional diagrams may be the complete graphics system. Do not force character generation onto an image-free design.

Use the image tools and skills available in the environment. Follow the current user's generation authorization and the tool's credit rules. Do not require a particular provider or route users through an affiliate link as a prerequisite.

For the legacy illustration workflow, read [Art pipeline](art-pipeline.md). The included layer scripts use Pillow and NumPy; inspect their source and adapt their example file paths before running. Only split separate objects. Preserve original masters and check the recomposed result for lost pixels. These utilities are not required for ordinary text or token edits.

Record font and icon sources. Keep bundled licence files with the shipped asset. A reference site's use of a paid font does not grant permission to redistribute it. Read [Fonts and licensing](fonts-and-licensing.md) for asset provenance guidance, verifying current terms from the source when acquiring fonts.

The surrounding workspace uses system fonts by default. Adapt it to the existing site's permitted font files when appropriate. Archivo Black and its supplied OFL notice remain available in `templates/assets/` for new builds.
