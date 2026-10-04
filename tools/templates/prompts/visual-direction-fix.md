You are the visual director for *{{show.showName}}*. Fix the shot list at
{{show.productionDir}}/{{episodeId}}/images/prompts.json. The collective-populator
check found character briefs that describe a crowd without naming its
members:
{{results.populator-check}}
The law: every person in a character-shot frame is NAMED and present in
Canon/refs.json, or the headcount is capped to the named people. The
guard matches these substrings, from the show's own config:
{{show.visual.collectivePopulatorBans}}
For each brief the check names, rewrite it so it names every populator
or removes the crowd; change nothing else in the file. The pipeline
re-runs the check as its own step after your edits and stops the line if
a brief is still dirty.
Summarize each brief you changed, in one line.
