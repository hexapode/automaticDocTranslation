const fs = require('fs/promises');

const { OpenAI }  = require("llamaindex");

const llm = new OpenAI({ model: "gpt-3.5-turbo-1106", temperature: 0,  apiKey: process.env["OPENAI_API_KEY"], maxRetries: 5});


const {Octokit} = require("@octokit/core");

const {encode} = require("gpt-tokenizer");


const octokit = new Octokit({
    auth: process.env["GITHUB_PERSONAL_ACCESS_TOKEN"]
})
  

async function getLastFileVersion(owner, repoName, path) {
    let docFiles = [];
    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: owner,
        repo: repoName,
        path: path,
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
      })
    for (const file of response.data) {
        if (file.type === 'dir') {
            const files = await getLastFileVersion(owner, repoName, file.path);
            docFiles = docFiles.concat(files);
        }
        if (file.type === 'file' && (file.name.endsWith('.md') || file.name.endsWith('.mdx'))) {
            docFiles.push(file);
        }
    }
    return docFiles;
}

async function listDocFiles(files, owner, repoName, path) {
   let newFiles = await getLastFileVersion(owner, repoName, path);

   for (let file of newFiles) { 
        let fileHandledFlag = false;
        for (let [index, oldFile] of files.entries()) {
            if (oldFile.path === file.path && oldFile.sha !== file.sha) {
                // TODO: handle files updates here, so we don't have to retranslate them
                fileHandledFlag = true;
                files[index] = file;
                file.history = oldFile;
                break;
            }
            else if (oldFile.path === file.path) {
                fileHandledFlag = true;
                break;
            }
        }

        if (!fileHandledFlag) {
            // add a new file
            files.push(file);
        }

   }
}

async function loadFiles(owner, repoName, files) {
    
    for (let file of files) {
        // do not reload file if already loaded
        if (!file.raw) {
            const response = await fetch(file.download_url);
            const text = await response.text();
            
            file.raw = text;
            file.token = encode(text).length;
        }
      
    }
}

// a function that takes a md file as a string and return a document hierarchical object
function parseMdStrToTree(file) {
    const lines = file.split('\n');
    const doc = [];
    let section = { title: '', level: 0, content: '' };
    doc.push(section);
    for (let line of lines) {
        const match = line.match(/^(#{1,6}) /);
        if (match) {
            const level = match[1].length;
            const title = line.substring(level + 1);
            section = {
                title: title,
                level: level,
                content: ''
            };
            doc.push(section);
        } else {
            section.content += line + '\n';
        }
    }
    return doc;
}

// a function that take a document hierarchical object and return a md file as a string
function parseTreeToMdStr(doc, code='') {
    let str = '';
    for (let block of doc) {
        if (code) {
            if (block.level > 0) { 
                str += '#'.repeat(block.level) + ' ' + block[`title_${code}`][0] + '\n';
            }
            str += block[`content_${code}`][0] + '\n';
        }
        else {
            str += '#'.repeat(block.level) + ' ' + block[`title`] + '\n';
            str += block[`content`] + '\n';
        }

    }
    return str;
}

// a sleep function as async
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function translateTextTree(textTree, language) {
         
    let text = parseTreeToMdStr(textTree);
    let messages = [];


    try {

         messages = [
            {
                "role": "system",
                "content": `
You are a expert technical writer. Your goal is to translate a technical documentation in ${language}. The user will provide the documentation in a markdown format. Translate it to ${language}. 

Guidelines:
- Only output the translated documentation in Markdown, do not add or remove content. 
- Do not try to translate function/api endpoint name, only translate the documentation. 
- If the documentation contain codeblocks, only translate commentaries, do not translate variable names / function names.
- Try to output it in ${language} that is easy to read, do not try to translate all expressions verbatim, make it so it feel professional. 
- If ${language} usually use the english word for a thing, keep it in English.
- Module names should be kept in English, add best effort translation. Always keep the original name in parenthesis, e.g. "聊天引擎 (ChatEngine)"

Additional Notes:
- it's a computer doc, build mean 'compile', watch mean 'looking at file that change',
- Keep the same structure as the original documentation, and retain ALL the links / images.
`,
            },
            {
                "role": "user",
                "content": `The markdown to translate (remember do not add extra content or remove content, just translate verbatim).\n Do not expend on content, only translate the documentation. The proposed text to translate may only contain a title, in this case only translate the title. Original in English:\n\n ${text} "\n\nTranslation in ${language}:\n\n`
            }
        ];


        const chatCompletion = await llm.chat(messages);


        // console.log(chatCompletion.choices[0].message.content)


        let translationTree = parseMdStrToTree(chatCompletion.message.content);
        
        let linkmatchesTranslated =chatCompletion.message.content.match(/\[.*\]\(.*\)/g);

        let matchesNonTranslated = text.match(/\[.*\]\(.*\)/g);

        // Not a good translation, try again
        while (
            linkmatchesTranslated != matchesNonTranslated 
            &&translationTree.length != textTree.length 
            && messages.length < 10) {
            messages.push({
                "role": "assistant",
                "content" : chatCompletion.message.content
            });

            // TODO: add more checks here
            if (translationTree.length > textTree.length) {
                messages.push({
                    "role": "user",
                    "content" : "The translation is seems too long, did you add too much content? redo it correctly. Only output the translation, no other contexts"
                });
            }
            else if (translationTree.length < textTree.length) {
                messages.push({
                    "role": "user",
                    "content" : "The translation is seems too short, did you forget some content? redo it correctly. Only output the translation, no other contexts"
                });
            }
            else if (linkmatchesTranslated < matchesNonTranslated) { 
                messages.push({
                    "role": "user",
                    "content" : "The translation is missing some Links!. Redo it correctly. Only output the translation, no other contexts"
                });
            }
            else if (linkmatchesTranslated > matchesNonTranslated) { 
                messages.push({
                    "role": "user",
                    "content" : "The translation have EXTRA Links!. Redo it correctly. Only output the translation, no other contexts"
                });
            }

            chatCompletion = await llm.chat(messages);
            translationTree = parseMdStrToTree(chatCompletion.message.content);
            linkmatchesTranslated = chatCompletion.message.content.match(/\[.*\]\(.*\)/g);   
        
        //console.log(chatCompletion.message.content)
        }


        return translationTree;
    }
    catch (e) {
        console.log(e);
        console.log('sleeping');
        console.log("=======\eerror on ", JSON.stringify(messages, null, 2));
        await sleep(30000)
        return translateTextTree(textTree, language);
    }
    
}


async function translateFile(file, language, code) {
    debugger;
    console.log("translating file:", file.name, code);
    if (!file.doc) {
        file.doc = parseMdStrToTree(file.raw);
    }
    // translate from bottom up to avoid solo title.
    for (let i = file.doc.length - 1; i >= 0; i--) {
        let block = file.doc[i];
        if (block["title_" + code] || block["content_" + code]) {
            // do not retranslate block!
            continue;
        }

        let blocks = [block];
        let level = block.level;

        for (j = i - 1; j >= 0; j--) {
            if (file.doc[j].level < level) {
                level = file.doc[j].level;
                blocks.unshift(file.doc[j]);
            }
        }

        let translationTree = await translateTextTree(blocks, language);
        
        if (translationTree.length != blocks.length) { 
            if (!file.translationError) {
                file.translationError = {};
            }
            file.translationError[code] = true;

        }

        for (let j = 0; j < blocks.length; j++) {
            if (!blocks[j]["title_" + code]) {
                blocks[j]["title_" + code] = []
            }
            if (!blocks[j]["content_" + code]) {
                blocks[j]["content_" + code] = []
            }

            blocks[j]["title_" + code].push(translationTree[j]?.title || '\n');
            blocks[j]["content_" + code].push(translationTree[j]?.content || '\n');
        }

    }

}

async function translateFiles(files, language, code, savepath) {
    let finished_jobs = 0;
    let started_jobs = 0;
    for (let file of files) {
        started_jobs++;
        let fn = async function() {
            console.log("translating:", file.name);
            await translateFile(file, language, code);
            await fs.writeFile(savepath, JSON.stringify(files, null, 2), 'utf8');
            finished_jobs++;
        }
        fn();
    }
    // wait that all jobs finished
    while (finished_jobs < started_jobs) {
        await sleep(1000);
        console.log(finished_jobs + '/' + started_jobs);
    }
}


async function correctLinkInFile(file, languageCode, docDir) {
    for (let block of file.doc) { 
        // find all markdown local link in block.content, BUT NOT IMAGES
        if (!block[`content_${languageCode}`]) {
            continue
        }
    
        let matchesTranslated = block[`content_${languageCode}`][0].match(/\[.*\]\(.*\)/g);

        let matchesNonTranslated = block[`content`].match(/\[.*\]\(.*\)/g);

        if (!matchesTranslated?.length != matchesNonTranslated?.length) {
            file.likelyLinkError = true;
            block[`likelyLinkError_${languageCode}`]= true;
            continue;
        }

        if (matchesNonTranslated?.length && matchesTranslated?.length) {
            
            for (let [index, nonTranslatedMatch] of matchesNonTranslated.entries()) {
                let translatedMatch = matchesTranslated[index];

                // replace translatedMatch with nonTranslatedMatch url with /{languageCode}/ append
                let newUrl = nonTranslatedMatch.match(/\(.*\)/)[0];

                // check if url is a local link (start with . or .. or /)
                if (newUrl.match(/^\(.*\)$/)) {
                    // MAKE THE URL RELATIVE TO `/${docDir}/${languageCode}/`
                    newUrl = newUrl.substring(1, newUrl.length - 1);
                    newUrl = `(/${docDir}/${languageCode}/${newUrl})`;     
                }

          

                let urlText =   translatedMatch.match(/\[.*\]/)[0];
                urlText = urlText.substring(1, urlText.length - 1);
                urlText = `[${urlText}]`;

               // console.log('Replace by', urlText + newUrl, 'match', translatedMatch);

               //  console.log( block[`content_${languageCode}`])
                block[`content_${languageCode}`][0] = block[`content_${languageCode}`][0].replace(translatedMatch, urlText + newUrl);


            }

        } 
                

    }

}

async function buildOutputMd(files, languageCode, targetDir, prefixToRemove) { 

    for (let file of files) {
        // check if file is translated in target language
        if (!file.doc || file.doc[0][`content_${languageCode}`] === undefined) { 
            console.log('failed to find translation', file.path);
            continue
        }

        await correctLinkInFile(file, languageCode);

        let translatedMd = parseTreeToMdStr(file.doc, languageCode);  
        let filePath = file.path.replace(prefixToRemove, '');
        let path = `${targetDir}/${filePath}`;

        // check if every directory in path exists and create if not
        let dirs = path.split('/');
        let dir = '';
        for (let i = 0; i < dirs.length - 1; i++) {
            dir += dirs[i] + '/';
            try {
                await fs.access(dir);
            } catch (error) {
                await fs.mkdir(dir);
            }
        }
        console.log(path); 
        await fs.writeFile(path, translatedMd, 'utf8');
    }
}

async function printFiles(files, owner, repoName, repoDocDir) {
    let targetDir = `${__dirname}/build/${owner}/${repoName}/${repoDocDir}`;
    for (let file of files) {
  
        let path = file.path.replace(repoDocDir, targetDir);
        // check if every directory in path exists and create if not
        let dirs = path.split('/');
        let dir = '';
        for (let i = 0; i < dirs.length - 1; i++) {
            dir += dirs[i] + '/';
            try {
                await fs.access(dir);
            } catch (error) {
                await fs.mkdir(dir);
            }
        }
        await fs.writeFile(path, file.raw, 'utf8');
    }
}

async function translateDoc(options) {

    const repoOwner = options.repoOwner;
    const repoName = options.repoName;
    const repoDocDir = options.repoDocDir;
    const language = options.language;
    const languageCode = options.languageCode;
    const savePath = options.savePath;
    const loadFile = options.loadFile || (options.loadFile === undefined) ? true : false; // default to true

    console.log(options);
    // const files = await listDocFiles(owner, repoName, repoDocDir);
    let files = [];
    let savepath  = `${savePath}/${repoOwner}/${repoName}.json`;
    try {
        await fs.access(savepath);
        console.log("Loading files from save file successfully")
        files = require(savepath);
    } catch {
        // create the save oath
        let dirs = savepath.split('/');
        let dir = '';
        for (let i = 0; i < dirs.length - 1; i++) {
            dir += dirs[i] + '/';
            try {
                await fs.access(dir);
            } catch (error) {
                await fs.mkdir(dir);
            }
        }
    }
    
    if (loadFile) {
        console.log("Loading files from Github");
        await listDocFiles(files, repoOwner, repoName, repoDocDir);
        await loadFiles(repoOwner, repoName, files);
    }

    await translateFiles(files, language, languageCode, savepath);
}


async function buildDoc(options) {
    const repoOwner = options.repoOwner;
    const repoName = options.repoName;
    const languageCode = options.languageCode;
    const savePath = options.savePath;
    const outputPath = options.outputPath;
    const prefixToRemove = options.prefixToRemove;

    
    
    // const files = await listDocFiles(owner, repoName, repoDocDir);
    let files = [];
    let savepath  = `${savePath}/${repoOwner}/${repoName}.json`;
    try {
        await fs.access(savepath);
        files = require(savepath);
        console.log("Loading files from save file successfully")        
    } catch {
        throw new Error('No save file found, please run translate first');
    }

    let outPath  = outputPath;
    try {
        await fs.access(outPath);
    } catch {
        // create the out path
        let dirs = outPath.split('/');
        let dir = '';
        for (let i = 0; i < dirs.length - 1; i++) {
            dir += dirs[i] + '/';
            try {
                await fs.access(dir);
            } catch (error) {
                await fs.mkdir(dir);
            }
        }
    }
    
    await buildOutputMd(files, languageCode, outputPath, prefixToRemove);
}

module.exports = 
{
    translateDoc: translateDoc,
    buildDoc: buildDoc
}