export class CharacterRegistryDO {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.sql = state.storage.sql;
		this.initializeSchema();
	}

	async initializeSchema() {
		try {
			// First create tables if they don't exist
			await this.createInitialSchema();
			// Then check and apply any needed column updates
			await this.applySchemaUpdates();
		} catch (error) {
			console.error("Error initializing character schema:", error);
			throw error;
		}
	}

	async createInitialSchema() {
		try {
			await this.sql.exec(`
		  -- Main characters table
		  CREATE TABLE IF NOT EXISTS characters (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			author TEXT NOT NULL,
			name TEXT NOT NULL,
			model_provider TEXT NOT NULL,
			bio TEXT,
			settings TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(author, name)
		  );	  
				
		  -- Clients table (e.g., DISCORD, DIRECT)
		  CREATE TABLE IF NOT EXISTS character_clients (
			character_id INTEGER,
			client TEXT NOT NULL,
			FOREIGN KEY(character_id) REFERENCES characters(id),
			PRIMARY KEY(character_id, client)
		  );
  
		  -- Lore entries
		  CREATE TABLE IF NOT EXISTS character_lore (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			character_id INTEGER,
			lore_text TEXT NOT NULL,
			order_index INTEGER,
			FOREIGN KEY(character_id) REFERENCES characters(id)
		  );
  
		  -- Message examples
		  CREATE TABLE IF NOT EXISTS character_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			character_id INTEGER,
			conversation_id INTEGER,
			user TEXT NOT NULL,
			content TEXT NOT NULL, -- JSON string for message content
			message_order INTEGER,
			FOREIGN KEY(character_id) REFERENCES characters(id)
		  );
  
		  -- Post examples
		  CREATE TABLE IF NOT EXISTS character_posts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			character_id INTEGER,
			post_text TEXT NOT NULL,
			FOREIGN KEY(character_id) REFERENCES characters(id)
		  );
  
		  -- Topics
		  CREATE TABLE IF NOT EXISTS character_topics (
			character_id INTEGER,
			topic TEXT NOT NULL,
			FOREIGN KEY(character_id) REFERENCES characters(id),
			PRIMARY KEY(character_id, topic)
		  );
  
		  -- Style settings
		  CREATE TABLE IF NOT EXISTS character_styles (
			character_id INTEGER,
			category TEXT NOT NULL, -- 'all', 'chat', or 'post'
			style_text TEXT NOT NULL,
			FOREIGN KEY(character_id) REFERENCES characters(id),
			PRIMARY KEY(character_id, category, style_text)
		  );
  
		  -- Adjectives
		  CREATE TABLE IF NOT EXISTS character_adjectives (
			character_id INTEGER,
			adjective TEXT NOT NULL,
			FOREIGN KEY(character_id) REFERENCES characters(id),
			PRIMARY KEY(character_id, adjective)
		  );
  
		  -- Create indexes
		  CREATE INDEX IF NOT EXISTS idx_characters_author 
		  ON characters(author);
		  
		  CREATE INDEX IF NOT EXISTS idx_characters_name 
		  ON characters(name);
		`);
		} catch (error) {
			console.error("Error initializing character schema:", error);
			throw error;
		}
	}

	async applySchemaUpdates() {
		try {
			// Get current columns
			const tableInfo = await this.sql.exec(`PRAGMA table_info(characters)`).toArray();
			const columns = tableInfo.map(col => col.name);

			// Begin transaction for all schema updates
			return await this.state.storage.transaction(async (txn) => {
				// Add vrm_url column if it doesn't exist
				if (!columns.includes('vrm_url')) {
					console.log('Adding vrm_url column to characters table');
					await this.sql.exec(`ALTER TABLE characters ADD COLUMN vrm_url TEXT;`);
				}

				// Add any other missing columns here in the future
				// Example:
				// if (!columns.includes('new_column')) {
				//   await this.sql.exec(`ALTER TABLE characters ADD COLUMN new_column TEXT;`);
				// }

				return true;
			});
		} catch (error) {
			console.error('Schema update error:', error);
			throw error;
		}
	}

	async handleMigrateSchema() {
		try {
			await this.applySchemaUpdates();
			return new Response(JSON.stringify({
				success: true,
				message: 'Schema migration completed successfully'
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			return new Response(JSON.stringify({
				success: false,
				error: 'Migration failed',
				details: error.message
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}


	async createOrUpdateCharacter(author, characterData) {
		try {
			return await this.state.storage.transaction(async (txn) => {
				// Insert/update main character record with vrm_url
				const result = await this.sql.exec(`
			  INSERT INTO characters (
				author,
				name,
				model_provider,
				bio,
				vrm_url,
				settings
			  ) VALUES (?, ?, ?, ?, ?, ?)
			  ON CONFLICT(author, name) DO UPDATE SET
				model_provider = EXCLUDED.model_provider,
				bio = EXCLUDED.bio,
				vrm_url = EXCLUDED.vrm_url,
				settings = EXCLUDED.settings,
				updated_at = CURRENT_TIMESTAMP
			  RETURNING id
			`,
					author,
					characterData.name,
					characterData.modelProvider || 'LLAMALOCAL',
					characterData.bio,
					characterData.vrmUrl,  // Include VRM URL from client
					JSON.stringify(characterData.settings || {
						model: 'claude-3-opus-20240229',
						voice: { model: 'en-US-neural' }
					})
				).one();

				const characterId = result.id;

				// Clear existing related data
				await this.sql.exec("DELETE FROM character_clients WHERE character_id = ?", characterId);
				await this.sql.exec("DELETE FROM character_lore WHERE character_id = ?", characterId);
				await this.sql.exec("DELETE FROM character_messages WHERE character_id = ?", characterId);
				await this.sql.exec("DELETE FROM character_posts WHERE character_id = ?", characterId);
				await this.sql.exec("DELETE FROM character_topics WHERE character_id = ?", characterId);
				await this.sql.exec("DELETE FROM character_styles WHERE character_id = ?", characterId);
				await this.sql.exec("DELETE FROM character_adjectives WHERE character_id = ?", characterId);

				// Insert clients with default if not provided
				const clients = characterData.clients || ['DIRECT'];
				for (const client of clients) {
					await this.sql.exec(
						"INSERT INTO character_clients (character_id, client) VALUES (?, ?)",
						characterId, client
					);
				}

				// Insert lore with empty array fallback
				const lore = characterData.lore || [];
				for (let i = 0; i < lore.length; i++) {
					await this.sql.exec(
						"INSERT INTO character_lore (character_id, lore_text, order_index) VALUES (?, ?, ?)",
						characterId, lore[i], i
					);
				}

				// Insert message examples with empty array fallback
				const messageExamples = characterData.messageExamples || [];
				for (let i = 0; i < messageExamples.length; i++) {
					const conversation = messageExamples[i];
					for (let j = 0; j < conversation.length; j++) {
						const message = conversation[j];
						await this.sql.exec(
							"INSERT INTO character_messages (character_id, conversation_id, user, content, message_order) VALUES (?, ?, ?, ?, ?)",
							characterId, i, message.user, JSON.stringify(message.content), j
						);
					}
				}

				// Insert post examples with empty array fallback
				const postExamples = characterData.postExamples || [];
				for (const post of postExamples) {
					await this.sql.exec(
						"INSERT INTO character_posts (character_id, post_text) VALUES (?, ?)",
						characterId, post
					);
				}

				// Insert topics with empty array fallback
				const topics = characterData.topics || [];
				for (const topic of topics) {
					await this.sql.exec(
						"INSERT INTO character_topics (character_id, topic) VALUES (?, ?)",
						characterId, topic
					);
				}

				// Insert style settings with default empty categories
				const style = characterData.style || { all: [], chat: [], post: [] };
				for (const [category, styles] of Object.entries(style)) {
					for (const styleText of styles) {
						await this.sql.exec(
							"INSERT INTO character_styles (character_id, category, style_text) VALUES (?, ?, ?)",
							characterId, category, styleText
						);
					}
				}

				// Insert adjectives with empty array fallback
				const adjectives = characterData.adjectives || [];
				for (const adjective of adjectives) {
					await this.sql.exec(
						"INSERT INTO character_adjectives (character_id, adjective) VALUES (?, ?)",
						characterId, adjective
					);
				}

				return characterId;
			});
		} catch (error) {
			console.error("Error creating/updating character:", error);
			throw error;
		}
	}

	async getCharactersByAuthor(author) {
		try {
			const characters = await this.sql.exec(`
			SELECT c.*, 
			  c.vrm_url,           -- Explicitly include vrm_url
			  c.model_provider,
			  c.bio,
			  c.settings,
			  c.created_at,
			  c.updated_at,
			  GROUP_CONCAT(DISTINCT cc.client) as clients,
			  GROUP_CONCAT(DISTINCT cl.lore_text) as lore,
			  GROUP_CONCAT(DISTINCT cp.post_text) as posts,
			  GROUP_CONCAT(DISTINCT ct.topic) as topics,
			  GROUP_CONCAT(DISTINCT ca.adjective) as adjectives
			FROM characters c
			LEFT JOIN character_clients cc ON c.id = cc.character_id
			LEFT JOIN character_lore cl ON c.id = cl.character_id
			LEFT JOIN character_posts cp ON c.id = cp.character_id
			LEFT JOIN character_topics ct ON c.id = ct.character_id
			LEFT JOIN character_adjectives ca ON c.id = ca.character_id
			WHERE c.author = ?
			GROUP BY c.id
			ORDER BY c.updated_at DESC
		  `, author).toArray();

			return Promise.all(characters.map(async (char) => {
				// Get message examples for each character
				const messages = await this.sql.exec(`
			  SELECT conversation_id, user, content, message_order
			  FROM character_messages
			  WHERE character_id = ?
			  ORDER BY conversation_id, message_order
			`, char.id).toArray();

				// Get styles for each character
				const styles = await this.sql.exec(`
			  SELECT category, style_text
			  FROM character_styles
			  WHERE character_id = ?
			`, char.id).toArray();

				return {
					name: char.name,
					modelProvider: char.model_provider,
					clients: char.clients ? char.clients.split(',') : [],
					bio: char.bio,
					vrmUrl: char.vrm_url,  // Make sure it's included in response
					lore: char.lore ? char.lore.split(',') : [],
					messageExamples: this.groupMessages(messages),
					postExamples: char.posts ? char.posts.split(',') : [],
					topics: char.topics ? char.topics.split(',') : [],
					style: this.groupStyles(styles),
					adjectives: char.adjectives ? char.adjectives.split(',') : [],
					settings: JSON.parse(char.settings || '{}'),
					created_at: char.created_at,
					updated_at: char.updated_at
				};
			}));
		} catch (error) {
			console.error("Error fetching characters for author:", error);
			throw error;
		}
	}

	async getCharacter(author, name) {
		try {
			// First check if character exists using toArray()
			const characterCheck = await this.sql.exec(`
				SELECT id FROM characters 
				WHERE author = ? AND name = ?
			  `, author, name).toArray();

			if (characterCheck.length === 0) {
				return null;
			}

			const character = await this.sql.exec(`
				SELECT c.*, 
				  c.vrm_url,           -- Explicitly include vrm_url
				  c.model_provider,
				  c.bio,
				  c.settings,
				  c.created_at,
				  c.updated_at,
				  GROUP_CONCAT(DISTINCT cc.client) as clients,
				  GROUP_CONCAT(DISTINCT cl.lore_text) as lore,
				  GROUP_CONCAT(DISTINCT cp.post_text) as posts,
				  GROUP_CONCAT(DISTINCT ct.topic) as topics,
				  GROUP_CONCAT(DISTINCT ca.adjective) as adjectives
				FROM characters c
				LEFT JOIN character_clients cc ON c.id = cc.character_id
				LEFT JOIN character_lore cl ON c.id = cl.character_id
				LEFT JOIN character_posts cp ON c.id = cp.character_id
				LEFT JOIN character_topics ct ON c.id = ct.character_id
				LEFT JOIN character_adjectives ca ON c.id = ca.character_id
				WHERE c.author = ? AND c.name = ?
				GROUP BY c.id
				LIMIT 1
			  `, author, name).toArray();


			if (character.length === 0) {
				return null;
			}

			const char = character[0];

			// Get message examples
			const messages = await this.sql.exec(`
			SELECT conversation_id, user, content, message_order
			FROM character_messages
			WHERE character_id = ?
			ORDER BY conversation_id, message_order
		  `, char.id).toArray();

			// Get styles
			const styles = await this.sql.exec(`
			SELECT category, style_text
			FROM character_styles
			WHERE character_id = ?
		  `, char.id).toArray();

			// Format the response
			return {
				name: char.name,
				modelProvider: char.model_provider,
				clients: char.clients ? char.clients.split(',') : [],
				bio: char.bio,
				vrmUrl: char.vrm_url,  // Make sure it's included in response
				lore: char.lore ? char.lore.split(',') : [],
				messageExamples: this.groupMessages(messages),
				postExamples: char.posts ? char.posts.split(',') : [],
				topics: char.topics ? char.topics.split(',') : [],
				style: this.groupStyles(styles),
				adjectives: char.adjectives ? char.adjectives.split(',') : [],
				settings: JSON.parse(char.settings || '{}'),
				created_at: char.created_at,
				updated_at: char.updated_at
			};
		} catch (error) {
			console.error("Error fetching character:", error);
			throw error;
		}
	}

	groupMessages(messages) {
		const conversations = {};
		for (const msg of messages) {
			if (!conversations[msg.conversation_id]) {
				conversations[msg.conversation_id] = [];
			}
			conversations[msg.conversation_id].push({
				user: msg.user,
				content: JSON.parse(msg.content)
			});
		}
		return Object.values(conversations);
	}

	groupStyles(styles) {
		const grouped = {};
		for (const style of styles) {
			if (!grouped[style.category]) {
				grouped[style.category] = [];
			}
			grouped[style.category].push(style.style_text);
		}
		return grouped;
	}

	async fetch(request) {
		if (request.method === "GET") {
			return new Response("Method not allowed", { status: 405 });
		}

		if (request.method === "POST") {
			const url = new URL(request.url);

			switch (url.pathname) {
				case '/migrate-schema': {
					return await this.handleMigrateSchema();
				}
				case '/create-character': {
					try {
						const { author, character } = await request.json();

						if (!author || !character) {
							return new Response(JSON.stringify({
								error: 'Missing required fields'
							}), {
								status: 400,
								headers: { 'Content-Type': 'application/json' }
							});
						}

						const characterId = await this.createOrUpdateCharacter(author, character);

						return new Response(JSON.stringify({
							success: true,
							characterId,
							message: 'Character created successfully'
						}), {
							headers: { 'Content-Type': 'application/json' }
						});
					} catch (error) {
						console.error('Create character error:', error);
						return new Response(JSON.stringify({
							error: 'Failed to create character',
							details: error.message
						}), {
							status: 500,
							headers: { 'Content-Type': 'application/json' }
						});
					}
				}
				case '/update-character': {
					try {
						const { author, character } = await request.json();

						if (!author || !character) {
							return new Response(JSON.stringify({
								error: 'Missing required fields'
							}), {
								status: 400,
								headers: { 'Content-Type': 'application/json' }
							});
						}

						const characterId = await this.createOrUpdateCharacter(author, character);

						return new Response(JSON.stringify({
							success: true,
							characterId,
							message: 'Character updated successfully'
						}), {
							headers: { 'Content-Type': 'application/json' }
						});
					} catch (error) {
						console.error('Update character error:', error);
						return new Response(JSON.stringify({
							error: 'Failed to update character',
							details: error.message
						}), {
							status: 500,
							headers: { 'Content-Type': 'application/json' }
						});
					}
				}
				case '/delete-character': {
					try {
						const { author, name } = await request.json();

						await this.sql.exec(`
						DELETE FROM characters 
						WHERE author = ? AND name = ?
					  `, author, name);

						return new Response(JSON.stringify({
							success: true,
							message: 'Character deleted successfully'
						}), {
							headers: { 'Content-Type': 'application/json' }
						});
					} catch (error) {
						console.error('Delete character error:', error);
						return new Response(JSON.stringify({
							error: 'Failed to delete character',
							details: error.message
						}), {
							status: 500,
							headers: { 'Content-Type': 'application/json' }
						});
					}
				}
				case '/get-character': {
					try {
						const { author, name } = await request.json();
						const character = await this.getCharacter(author, name);

						if (!character) {
							return new Response(JSON.stringify({ error: 'Character not found' }), {
								status: 404,
								headers: { 'Content-Type': 'application/json' }
							});
						}

						return new Response(JSON.stringify(character), {
							headers: { 'Content-Type': 'application/json' }
						});
					} catch (error) {
						console.error('Get character error:', error);
						return new Response(JSON.stringify({
							error: 'Internal server error',
							details: error.message
						}), {
							status: 500,
							headers: { 'Content-Type': 'application/json' }
						});
					}
				}
				case '/get-author-characters': {
					const { author } = await request.json();
					const characters = await this.getCharactersByAuthor(author);
					return new Response(JSON.stringify(characters), {
						headers: { 'Content-Type': 'application/json' }
					});
				}

				default:
					return new Response('Not found', { status: 404 });
			}
		}

		return new Response('Method not allowed', { status: 405 });
	}
}