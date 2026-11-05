You are the visual director for *{{show.showName}}*. Fix the shot list at
{{show.productionDir}}/{{episodeId}}/images/prompts.json. The shot-list
check found:
{{results.shot-list-check}}
The law: one establishing shot per scene header of
{{show.episodesDir}}/{{episodeId}}/script.md, id `s<n>-establishing`,
`scene` equal to the header; an establishing brief names no person of
`Canon/cast.json` (kind character, human, creature or species) and lists
in `refs` every place it names that has a reference image; a character
shot's refs are cast-index keys with a reference image on disk; no
`prompt` or `seed` keys. For each reason the check names, repair that shot (add the
missing scene's shot, remove the extra, rewrite the brief around the
name, drop the key) and change nothing else. The pipeline re-runs the
check as its own step after your edits and stops the line if it still
fails.
Summarize each change in one line.
