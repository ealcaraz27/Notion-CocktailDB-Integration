const http = require('http');
const https = require('https');
const port = 3000;
const server = http.createServer();
const sessions = [];

const url = require('url');
const fs = require('fs');
const queryString = require('querystring');
const crypto = require('crypto');

const {client_id, client_secret, database_id} = require("./auth/credentials.json");
server.on("listening", listening_handler);
server.listen(port);
function listening_handler(){
	console.log(`Now Listening on Port ${port}`);
}

server.on("request", connection_handler);
function connection_handler(req, res){
    console.log(`New Request for ${req.url} from ${req.socket.remoteAddress}`);
    if(req.url === '/'){
		const main = fs.createReadStream('html/index.html');
		res.writeHead(200, {'Content-Type':'text/html'});
		main.pipe(res);
	}
	else if(req.url.startsWith('/find-recipe')){
		const user_input = new URL(req.url, "http://localhost:3000");
		const search = user_input.searchParams.get('search');
		const state = crypto.randomBytes(20).toString("hex");
		sessions.push({search, state});

		const token_cache_file = './cache/token_auth.json';
		if(fs.existsSync(token_cache_file)){
			cached_token = require(token_cache_file);
			let access_token = cached_token.access_token;
			get_drink_recipe({search}, access_token, res);
		}
		else{
			redirect_to_notion(state, res);
		}
	}
	else if(req.url.startsWith('/auth/notion/callback')){
		const user_input = new URL(req.url, "http://localhost:3000");
		const code = user_input.searchParams.get('code');
		const state = user_input.searchParams.get('state');
		let session = sessions.find((session) => session.state === state);
		if (code === undefined || state === undefined || session === undefined){
			res.writeHead(404, {'Content-Type':'text/plain'});
			res.end('404 Not Found');
		}
		const {search} = session;
		request_access_token(code, {search} , res);
	}
	else{
		res.writeHead(404, {'Content-Type':'text/plain'});
		res.end('404 Not Found');
	}
}

function redirect_to_notion(state, res){
	// redirect link is generated by notion API
	const auth_endpoint = `https://api.notion.com/v1/oauth/authorize?client_id=${client_id}&response_type=code&owner=user&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fnotion%2Fcallback&state=${state}`;
	res.writeHead(302, {"Location":`${auth_endpoint}`});
	res.end();
}

function request_access_token(code, user_input, res){
	const base64data = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
	const token_endpoint = "https://api.notion.com/v1/oauth/token";
	const post_data = JSON.stringify({"grant_type":"authorization_code", "code":`${code}`,"redirect_uri": "http://localhost:3000/auth/notion/callback"});
	const options = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Basic ${base64data}`,
			"Notion-Version": "2022-06-28"
		}
	};
	https.request(token_endpoint, options, (token_stream) => process_stream(token_stream, receieved_token, user_input, res)).end(post_data);
}

function process_stream(stream, callback, ...args){
	let body = "";
	stream.on("data", (chunk) => (body += chunk));
	stream.on("end", () => callback(body, ...args));
}

function receieved_token(body, user_input, res){
	const token_obj = JSON.parse(body);
	const access_token = token_obj.access_token;
	create_access_token_cache(token_obj);
	get_drink_recipe(user_input, access_token, res);
}

function create_access_token_cache(access_token){
	// Notion API access token doesnt expire
	fs.writeFile("./cache/token_auth.json", JSON.stringify(access_token), () => "Access Token Cached");
}

function get_drink_recipe(user_input, access_token, res){
	const {search} = user_input;
	const formatted_search = queryString.stringify({s:`${search}`});
	const rand_recipe_endpoint = "https://thecocktaildb.com/api/json/v1/1/random.php";
	const recipe_endpoint = `https://thecocktaildb.com/api/json/v1/1/search.php?${formatted_search}`;
	if(search == 'Random'){
		const rand_recipe_request = https.request(rand_recipe_endpoint, {method: "GET"});
		rand_recipe_request.on("response", (stream) => process_stream(stream, receive_recipe, user_input, access_token, res));
		rand_recipe_request.end();
	}
	else{
		const recipe_request = https.request(recipe_endpoint, {method: "GET"});
		recipe_request.on("response", (stream) => process_stream(stream, receive_recipe, user_input, access_token, res));
		recipe_request.end();
	}
}

function receive_recipe(body, user_input, access_token, res){
	const recipe_object = JSON.parse(body);
	if(recipe_object.drinks == null){
		// if drink does not exist redirect 404
		res.writeHead(404, {'Content-Type':'text/plain'});
		res.end(`404 Not Found`);
	}
	else{
		const notion_recipe = format_notion_recipe(recipe_object);
		create_page_request(notion_recipe, access_token, res);
	}

	function format_notion_recipe(recipe_object){
		const first_recipe = recipe_object.drinks[0];
		const recipe_data = {
			strDrink: first_recipe.strDrink,
			strAlcoholic: first_recipe.strAlcoholic,
			strInstructions: first_recipe.strInstructions,
			strDrinkThumb: first_recipe.strDrinkThumb,
			ingredient_list: "",
			measures_list: ""
		};
		for(let i = 1; i <= 15; i++){
			const ingredientKey = `strIngredient${i}`;
			const measureKey = `strMeasure${i}`;
			if(first_recipe[ingredientKey] !== null && first_recipe[ingredientKey] !== ''){
				recipe_data[ingredientKey] = first_recipe[ingredientKey];
				recipe_data.ingredient_list += `${recipe_data[ingredientKey]} | `;
			}
			if(first_recipe[measureKey] !== null && first_recipe[measureKey] !== ''){
				recipe_data[measureKey] = first_recipe[measureKey];
				recipe_data.measures_list += `${recipe_data[measureKey]} | `;
			}
		}
		return recipe_data;
	}
}

function create_page_request(notion_recipe, access_token, res){
	const page_endpoint = "https://api.notion.com/v1/pages";
	const post_data = JSON.stringify(
		{
			"parent" : {
				"database_id": `${database_id}`
			},
			"icon": {
				"type": "emoji",
				"emoji": "🍸"
			},
			"cover": {
				"type": "external",
				"external": {
					"url": `${notion_recipe.strDrinkThumb}`
				}
			},
			"properties": {
				"Name": {
					"title": [
						{
							"type": "text",
							"text": {
								"content": `${notion_recipe.strDrink} Recipe (${notion_recipe.strAlcoholic}) - Created via Notion API`
							}
						}
					]
				}
			},
			"children": [
				{
					"object": "block",
					"type": "heading_2",
					"heading_2": {
						"rich_text": [
							{
								"type": "text",
								"text": {
									"content": `${notion_recipe.strDrink}`
								}
							}
						]
					}
				},
				{
					"object": "block",
					"type": "paragraph",
					"paragraph": {
						"rich_text": [
							{
								"type": "text",
								"text": {
									"content": "Instructions: \n"
								}
							},
							{
								"type": "text",
								"text": {
									"content": `${notion_recipe.strInstructions} \n`
								}
							}
						]
					}
				},
				{
					"object": "block",
					"type": "paragraph",
					"paragraph": {
						"rich_text": [
							{
								"type": "text",
								"text": {
									"content": `Ingredients: \n ${notion_recipe.ingredient_list} \n`
								}
							},
							{
								"type": "text",
								"text": {
									"content": `Measurements: \n ${notion_recipe.measures_list}`
								}
							}
						]
					}
				},
			]
		}
	);
	const options = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${access_token}`,
			"Notion-Version": "2022-06-28"
		}
	}
	const create_page = https.request(page_endpoint, options);
	create_page.on("response", (stream) => process_stream(stream, recieve_page_response, res));
	create_page.end(post_data);
}
function recieve_page_response(body, res){
	const {url} = JSON.parse(body);
	res.writeHead(302, {Location: `${url}`});
	res.end();
}