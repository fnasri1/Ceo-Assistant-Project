import dotenv from 'dotenv';
import fs from 'fs';
import http from 'http';
import { Octokit, App } from 'octokit';
import { createNodeMiddleware } from '@octokit/webhooks';
import axios from 'axios';
// Load environment variables from .env file
dotenv.config();

// Set configured values
const appId = process.env.APP_ID;
const privateKeyPath = process.env.PRIVATE_KEY_PATH;
const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
const secret = process.env.WEBHOOK_SECRET;
const enterpriseHostname = process.env.ENTERPRISE_HOSTNAME;
const openAiKey= process.env.Open_AI_Key;
// Create an authenticated Octokit client authenticated as a GitHub App
const app = new App({
  appId,
  privateKey,
  webhooks: {
    secret
  },
  ...(enterpriseHostname && {
    Octokit: Octokit.defaults({
      baseUrl: `https://${enterpriseHostname}/api/v3`
    })
  })
});

// Define date range
const startDate = new Date('2023-12-30');
const endDate = new Date('2024-01-01');

app.webhooks.on('pull_request.opened', async ({ octokit, payload }) => {
  try {
    const response = await octokit.rest.pulls.list({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      state: 'closed',
      sort: 'updated',
      direction: 'desc'
    });

    const mergedPRs = response.data.filter(pr => {
      const mergedAt = new Date(pr.merged_at);
      return pr.merged_at && mergedAt >= startDate && mergedAt <= endDate;
    });

    let changesString = "";
    
    for (const pr of mergedPRs) {
      const prNumber = pr.number;
      changesString += `---> Pull Request #${prNumber}:\n`;

      const commitsResponse = await octokit.rest.pulls.listCommits({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pull_number: prNumber,
      });

      for (const commit of commitsResponse.data) {
        const commitDetailsResponse = await octokit.rest.repos.getCommit({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          ref: commit.sha,
        });

        for (const file of commitDetailsResponse.data.files) {
          changesString += `--> File modified: ${file.filename}:\n`;
          changesString += `-> Code modified in ${file.filename}:\n`;

          const patchLines = file.patch.split('\n');
          for (const line of patchLines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
              changesString += `+ ${line.substring(1)}\n`;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              changesString += `- ${line.substring(1)}\n`;
            }
          }
        }
      }
    }
    console.log(changesString)
    // Construct the full prompt using the template and changesString
    const fullPrompt = `Tu recevras un texte contenant les informations suivantes : 
    1. Les Pull Requests merged pendant une période définie, identifiées par "---> Pull Request #X:".
    2. Les noms des fichiers modifiés dans chaque Pull Request, mentionnés comme "--> Fichier modifié: [Nom du fichier].".
    3. Les modifications spécifiques apportées à chaque fichier, présentées sous la forme "-> Code modifié dans [Nom du fichier]".

    Ta tâche principale est de rédiger un rapport final destiné au chef d'équipe non technique qui :
    1. Commence par un salut informel, tel que "Bonjour," et se termine par "Cordialement, Votre assistant virtuel."
    2. Résume les impacts des modifications apportées dans les Pull Requests merged, en utilisant un langage clair et non technique, sans inclure de bouts de code ou de détails techniques spécifiques.
    3. Explique l'importance des changements en termes d'améliorations fonctionnelles, d'esthétique, de convivialité ou de performance, en mettant l'accent sur leur pertinence pour le projet global.
    4. Utilise des éléments visuels comme des schémas pour clarifier les points clés et faciliter la compréhension.
    5. Évite les spécifications techniques et se concentre sur l'essentiel des modifications et leur impact sur le projet.
    6. Mentionne si des informations clés pour comprendre l'impact global des modifications sont manquantes ou ambiguës, tout en restant concis et direct.

    Note importante : Le rapport doit être compréhensible pour un public non technique, mettant l'accent sur l'avancement et l'impact des modifications sur le projet sans s'attarder sur les détails techniques.

    texte : ${changesString}`;
    const openAiHeaders = {
      'Authorization': `Bearer ${openAiKey}`,
      'Content-Type': 'application/json'
    };
    const openAiPayload = {
      prompt: fullPrompt,
      max_tokens: 500 // Adjust as needed
    };
    axios.post('https://api.openai.com/v1/engines/davinci/completions', openAiPayload, { headers: openAiHeaders })
    .then(openAiResponse => {
      const summary = openAiResponse.data.choices[0].text;
      console.log(summary);
      // Further processing...
    })
    .catch(error => {
      console.error(`Error in ChatGPT API call: ${error}`);
    });


  } catch (error) {
    console.error(`Error: ${error}`);
  }
});

// Optional: Handle errors
app.webhooks.onError((error) => {
  if (error.name === 'AggregateError') {
    // Log Secret verification errors
    console.log(`Error processing request: ${error.event}`)
  } else {
    console.log(error)
  }
})

// Launch a web server to listen for GitHub webhooks
const port = process.env.PORT || 3000
const path = '/api/webhook'
const localWebhookUrl = `http://localhost:${port}${path}`

// See https://github.com/octokit/webhooks.js/#createnodemiddleware for all options
const middleware = createNodeMiddleware(app.webhooks, { path })

http.createServer(middleware).listen(port, () => {
  console.log(`Server is listening for events at: ${localWebhookUrl}`)
  console.log('Press Ctrl + C to quit.')
})
