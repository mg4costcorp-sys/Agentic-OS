# System

Document the decisions the website actually uses. The System view is a working reference for editing that same site.

Show the real typefaces at their actual sizes, semantic colours, spacing, corner radii and component states. Let swatches copy their current values. Calculate contrast from the current tokens so a later colour edit cannot leave an outdated ratio in the documentation.

Keep colour names semantic: canvas, surface, ink, muted, accent. A border colour is not automatically a readable text colour. Measure every relevant text pair against the surface on which it appears. Keep focus indicators visible on both light and dark surfaces.

Use live button specimens for default, hover, focus and disabled states. Explain any component behaviour that a future editor needs to preserve. Put a short reference lineage in this view, with links and the particular contribution from each source.

When typography or colour changes, update the real token and its specimens together. A token edit that changes the site but leaves the system book stale is incomplete. When a new component is introduced, document only its useful states rather than adding unused library components.
