#!/usr/bin/env node
/**
 * The spec analyzer takes a relative path to a crawl report or to a folder that
 * contains an `index.json` file that is the crawl report and creates a report
 * that contains, for each spec, a list of potential anomalies.
 *
 * Provided Strudy was installed as a global package, the spec analyzer can be
 * called directly through:
 *
 * `strudy [options] [report]`
 *
 * Use the `--help` option for usage instructions.
 *
 * If Strudy was not installed as a global package, call:
 *
 * `node strudy.js [options] [report]`
 *
 * @module crawler
 */

const commander = require('commander');
const { constants: fsConstants } = require('fs');
const fs = require('fs/promises');
const pandoc = require('node-pandoc');
const path = require('path');
const satisfies = require('semver/functions/satisfies');
const requireFromWorkingDirectory = require('./src/lib/require-cwd');
const { version, engines } = require('./package.json');
const { studyCrawl } = require('./src/lib/study-crawl.js');
const { generateReport } = require('./src/lib/generate-report.js');


// Warn if version of Node.js does not satisfy requirements
if (engines && engines.node && !satisfies(process.version, engines.node)) {
  console.warn(`
[WARNING] Node.js ${process.version} detected but Strudy needs Node.js ${engines.node}.
          Please consider upgrading Node.js if the program crashes!`);
}


async function exists(file) {
  try {
    await fs.access(file, fsConstants.R_OK);
    return true;
  }
  catch {
    return false;
  }
}


async function isStudyReport(file) {
  const fd = await fs.open(file, 'r');
  try {
    const buff = Buffer.alloc(1024);
    await fd.read(buff, 0, 1024);
    const str = buff.toString();
    if (str.match(/"type"\s*:\s*"study"/)) {
      return true;
    }
  }
  catch {
    return false;
  }
  finally {
    await fd.close();
  }
}


const program = new commander.Command();
program
  .name('strudy')
  .description('Analyzes a crawl report generated by Reffy')
  .version(version)
  .usage('[options] <report>')
  .argument('<report>', 'Path/URL to crawl report or study file')
  .option('-f, --format <format>', 'create a markdown/HTML report from study file')
  .option('-d, --diff <refstudy>', 'create a diff from some reference study')
  .option('-s, --spec <specs...>', 'restrict analysis to given specs')
  .option('--dep', 'create a dependencies report')
  .option('--onlynew', 'only include new diff in the diff report')
  .option('--perissue', 'create a markdown/HTML report per issue')
  .option('--tr <trreport>', 'Path/URL to crawl report on published specs')
  .showHelpAfterError('(run with --help for usage information)')
  .addHelpText('after', `
Minimal usage example:
  To study a crawl report in current folder:
    $ strudy .

Description:
  Analyzes a crawl report generated by Reffy and create a report with potential
  anomalies in each of the specs contained in the crawl report.

  The report is written to the console as a serialized JSON object or as a
  markdown or HTML report depending on command options.

Argument:
<report>
  Path to the crawl report to analyze. If the path leads to a folder, Strudy
  will look for an "ed/index.json" file under that folder first (if it exists,
  it will also look for a possible "tr/index.json" file to set the --tr option),
  then for an "index.json" file.

Usage notes for some of the options:
-f, --format <format>
  Tell Strudy to return a report in the specified format. Format may be one of
  "json" (default when option is not set), "markdown" or "html".

  When the option is specified to either "markdown" or "html", the report
  pointed to by <report> may be a JSON file that contains a Strudy report.

-d, --diff <refstudy>
  Tell Strudy tool to return a diff from the provided reference Strudy report.
  <refstudy> must point to a Strudy report.

  When the option is specified, the report pointed to by <report> may be a JSON
  file that contains a Strudy report.

  Diff reports are in markdown and the "--format" option, if specified, must be
  "markdown".

  The --diff option and the --dep option cannot both be set.

-s, --spec <specs...>
  Valid spec values may be a shortname, a URL, or a relative path to JSON file
  that contains a list of spec URLs and/or shortnames. Shortnames may be the
  shortname of the spec series.

  Use "all" to include all specs. This is equivalent to not setting the option
  at all.

  For instance:
    $ strudy . --spec picture-in-picture https://w3c.github.io/mediasession/

--dep
  Tell Strudy to return a dependencies report.

  When the option is specified, the report pointed to by <report> may be a JSON
  file that contains a Strudy report.

  Dependencies reports are in markdown and the "--format" option, if specified,
  must be "markdown".

  The --diff option and the --dep option cannot both be set.

--perissue
  Markdown/HTML reports are per spec by default. Set this option to tell Strudy
  to generate markdown/HTML reports per issue instead.

  The --diff option must not be set.
  The --format option must be set to either "markdown" or "html".

--tr <trreport>
  Useful for Strudy to refine its broken link analysis when crawl report
  contains info about latest Editor's Drafts.

  A spec that references terms defined in a second spec for which the /TR
  version lags behind the Editor's Draft may have issues of the form "The term
  exists in the /TR version but no longer exists in the Editor's Draft".

  Note that if <report> is a link to a folder, the tool will automatically look
  for the TR crawl report in a "tr" subfolder and set <trreport> itself.
`)
  .action(async (report, options) => {
    if (options.format && !['json', 'markdown', 'html'].includes(options.format)) {
      console.error(`Unsupported --format option "${options.format}".
Format must be one of "json", "markdown" or "html".`)
      process.exit(2);
    }
    if (options.diff && options.format && (options.format !== 'markdown')) {
      console.error(`Diff reports are always in markdown.
The --format option can only be set to "markdown" when --diff is used.`);
      process.exit(2);
    }
    if (options.diff && options.perissue) {
      console.error('The --diff and --perissue options cannot both be set.');
      process.exit(2);
    }
    if (options.perissue && !['markdown', 'html'].includes(options.format)) {
      console.error('The --format option must be "markdown" or "html" when --perissue is set.')
      process.exit(2);
    }
    if (options.dep && options.diff) {
      console.error('The --dep and --diff options cannot both be set.');
      process.exit(2);
    }

    let edReport = report;
    let trReport = options.tr;
    if (!report.endsWith('.json')) {
      if (await exists(path.join(report, 'ed'))) {
        edReport = path.join(report, 'ed');
        if (!trReport && await exists(path.join(report, 'tr'))) {
          trReport = path.join(report, 'tr');
        }
      }
      edReport = path.join(edReport, 'index.json');
    }
    if (!await exists(edReport)) {
      console.error(`Could not find/access crawl/study report: ${report}`);
      process.exit(2);
    }
    if (trReport) {
      if (!trReport.endsWith('.json')) {
        trReport = path.join(trReport, 'index.json');
      }
      if (!await exists(trReport)) {
        console.error(`Could not find/access TR crawl report: ${options.tr}`);
        process.exit(2);
      }
    }

    // Specified report may already be the study report
    // To find out, we'll do a bit of content sniffing to avoid loading the
    // report twice (report file may be somewhat large).
    let study = null;
    const isStudy = await isStudyReport(edReport);
    if (isStudy) {
      study = requireFromWorkingDirectory(edReport);
    }

    if (!study) {
      const studyOptions = {
        include: options.spec ?? null,
        trResults: trReport
      }
      study = await studyCrawl(edReport, studyOptions);
    }

    let res = null;
    if (options.diff || options.dep) {
      // Generate diff/dependencies report
      res = await generateReport(study, {
        depReport: options.dep,
        diffReport: !!options.diff,
        refStudyFile: options.diff,
        onlyNew: options.onlynew
      });
    }
    else if (options.format && options.format !== 'json') {
      // Generate markdown report and possibly an HTML report
      const generateOptions = { perSpec: !options.perissue };
      const markdown = await generateReport(study, generateOptions);

      if (options.format === 'html') {
        const template = path.join(__dirname, 'src', 'templates',
          `report${options.perissue ? '-perissue' : ''}-template.html`);
        const promise = new Promise((resolve, reject) => {
          let args = [
            '-f', 'markdown', '-t', 'html5', '--section-divs', '-s',
            '--template', template
          ];
          pandoc(markdown, args, (err, result) =>
            err ? reject(err) : resolve(result));
        });
        res = await promise;
      }
      else {
        res = markdown;
      }
    }
    else {
      // Output the study report to the console
      res = JSON.stringify(study, null, 2);
    }

    console.log(res);
  });

program.parseAsync(process.argv);