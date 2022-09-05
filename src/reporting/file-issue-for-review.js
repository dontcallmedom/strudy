/* Takes a reports of anomaly produced by strudy,
   creates a draft of an issue per spec and per anomaly type
   and submits as a pull request in this repo if no existing one matches
*/
const {studyBackrefs, loadCrawlResults} = require("../lib/study-backrefs");
const path = require("path");
const fs = require("fs").promises;
const { execSync } = require('child_process');
const Octokit = require("../lib/octokit");

const GH_TOKEN = (() => {
  try {
    return require("../config.json").GH_TOKEN;
  } catch (err) {
    return process.env.GH_TOKEN;
  }
})();

if (!GH_TOKEN) {
  console.error("GH_TOKEN must be set to some personal access token as an env variable or in a config.json file");
  process.exit(1);
}

const octokit = new Octokit({
  auth: GH_TOKEN,
  //log: console
});


if (require.main === module) {
  let edCrawlResultsPath = process.argv[2];
  let trCrawlResultsPath = process.argv[3];
  // Target the index file if needed
  if (!edCrawlResultsPath.endsWith('index.json')) {
    edCrawlResultsPath = path.join(edCrawlResultsPath, 'index.json');
  }
  if (!trCrawlResultsPath.endsWith('index.json')) {
    trCrawlResultsPath = path.join(trCrawlResultsPath, 'index.json');
  }
  (async function() {
    const crawl = await loadCrawlResults(edCrawlResultsPath, trCrawlResultsPath);
    const results = await studyBackrefs(crawl.ed, crawl.tr);
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    Object.keys(results).slice(0,2).forEach(async uri => {
      const specResult = results[uri];
      // FIXME
      const brokenLinks = specResult.brokenLinks?.filter(u => !u.match(/w3\.org\/TR\//)) || [];
      if (brokenLinks.length) {
	const issueMoniker = `${specResult.shortname}-brokenlinks`;
	// is there already a file with that moniker?
	const issueFilename = path.join('issues/', issueMoniker + '.md');
	try {
	  if (!(await fs.stat(issueFilename)).isFile()) {
	    console.error(`${issueFilename} already exists but is not a file`);
	  } else {
	    console.log(`${issueFilename} already exists, bailing`);
	  }
	  return;
	} catch (err) {
	  // Intentionally blank
	}
	// if not, is there a pull request that uses that moniker as a branch
	// FIXME
	const {data: pullrequests} = {data: []} || (await octokit.rest.pulls.list({
	  owner: "w3c",
	  repo: "strudy",
	  head: `w3c:${issueMoniker}`
	}));
	if (pullrequests.length > 0) {
	  console.log(JSON.stringify(pullrequests, null, 2));
	  console.log(`A pull request from branch ${issueMoniker} already exists, bailing`);
	  return;
	}
	// if not, we create the file, add it in a branch
	// and submit it as a pull request to the repo
	const issueReport = `
Repo: ${specResult.repo}
Tracked: N/A
Issue title: Broken references in ${specResult.title}
---
While crawling [${specResult.title}](${specResult.crawled}), the following links to other specifications were detected as pointing to non-existing anchors, which should be fixed:
${brokenLinks.map(link => `* [ ] ${link}`).join("\n")}

This issue was detected and reported semi-automatically by [strudy](https://github.com/w3c/strudy/) based on data collected in [webref](https://github.com/w3c/webref/).`;
	await fs.writeFile(issueFilename, issueReport, 'utf-8');
	execSync(`git checkout -b ${issueMoniker}`);
	execSync(`git add ${issueFilename}`);
	execSync(`git commit -m "File report on broken links found in ${specResult.title}"`);
	execSync(`git checkout ${currentBranch}`);
      }
    });
  })();
}
