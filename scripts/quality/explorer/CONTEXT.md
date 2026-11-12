# Reader map view source

One job: explain and navigate the existing source-map snapshot offline.

- Parent explorer.mjs assembles the generated architecture/Explorer.html.
- descriptions.mjs owns plain-language labels and illustrative walkthroughs.
- client.mjs owns navigation, filtering and source-link details.
- style.css and page.html own presentation and static structure.

Inputs are source paths, hashes and link evidence from map.mjs; never app data,
credentials or source text. Parsed links and illustrative request flow stay labeled
separately. Normal checks regenerate the output. Run npm run test:map to verify the
actual offline browser workflow. Edit these sources, not the generated HTML.
