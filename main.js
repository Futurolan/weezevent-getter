const fetch = require('node-fetch')
const crypto = require('crypto')

let cache = {}

init()

function init () {
  start().catch((err) => {
    console.error(err)
  }).finally(() => {
    console.log('Wait 5min before next run')
    setTimeout(init, 5 * 60 * 1000)
  })
}

async function start () {
  // Get editions from backend
  const query = `
  {
    nodeQuery(filter: {conditions: [{field: "type", value: ["edition"], operator: EQUAL}, {field: "status", value: ["1"]}, {field: "field_edition_weezevent_active",value:["1"]}]}, limit: 9999) {
      nodes:entities {
       ... on NodeEdition{
        nid
        title
        eventId:fieldEditionWeezeventEventId
        }
      }
    }
  }`

  const res = await fetch(`${process.env.BACKEND_API_URL}/graphql?query=${encodeURI(query)}`)
  const json = await res.json()

  for (let index in json.data.nodeQuery.nodes) {
    const edition = json.data.nodeQuery.nodes[index]
    await parseEdition(edition.nid, edition.title, edition.eventId)
  }
}

async function parseEdition (editionNid, editionTitle, editionWeezeventEventId) {
  console.log(`Fetching tournaments for edition "${editionTitle}"`)
  if (editionWeezeventEventId === null) {
    console.log(`ERROR Field eventId is missing for edition "${editionTitle}" with nid ${editionTitle}`)
    return
  }

  // Get the weezevent tickets
  const res = await fetch(`https://api.weezevent.com/tickets?access_token=${process.env.WEEZEVENT_ACCESS_TOKEN}&api_key=${process.env.WEEZEVENT_API_KEY}&id_event[]=${editionWeezeventEventId}`)
  const weezeventTickets = await res.json()

  // Get tournaments from the current edition
  const query = `
  {
    nodeQuery(filter: {conditions: [{field: "type", value: ["tournament"], operator: EQUAL}, {field: "status", value: ["1"]}, {field: "field_tournament_edition",value:["${editionNid}"]}]}, limit: 9999) {
      nodes:entities {
       ... on NodeTournament{
          nid
          title
          tournamentWeezeventId:fieldTournamentWeezeventId
          teamSize:fieldWeezeventTeamSize
        }
      }
    }
  }`

  const res2 = await fetch(`${process.env.BACKEND_API_URL}/graphql?query=${encodeURI(query)}`)
  const json = await res2.json()

  for (let index in json.data.nodeQuery.nodes) {
    const tournament = json.data.nodeQuery.nodes[index]

    await getTournamentParticipants(editionWeezeventEventId, tournament.nid, tournament.title, tournament.tournamentWeezeventId, weezeventTickets, tournament.teamSize)
  }
}

async function getTournamentParticipants (editionWeezeventEventId, tournamentNid, tournamentTitle, tournamentWeezeventId, weezeventTickets, teamSize) {
  console.log(`Fetching participants & tickets for tournament "${tournamentTitle}"`)

  if (tournamentWeezeventId === null) {
    console.log(`ERROR Field tournamentWeezeventId is missing for tournament "${tournamentTitle}" with nid ${tournamentNid}`)
    return
  }
  const groupSize = teamSize
  if (groupSize === undefined) {
    console.log(`ERROR Cannot find ticket ${tournamentWeezeventId} for tournament "${tournamentTitle}" with nid ${tournamentNid}`)
    return
  }

  const res = await fetch(`https://api.weezevent.com/participant/list?access_token=${process.env.WEEZEVENT_ACCESS_TOKEN}&api_key=${process.env.WEEZEVENT_API_KEY}&id_event[]=${editionWeezeventEventId}&id_ticket[]=${tournamentWeezeventId}&full=true`)
  const json = await res.json()

  const md5 = crypto.createHash('md5').update(JSON.stringify(json.participants)).digest('hex')
  if (cache[`${editionWeezeventEventId}_${tournamentWeezeventId}`] === md5) {
    console.log(`Same data with hash ${md5} already processed for tournament "${tournamentTitle}" with nid ${tournamentNid} !!! Do nothing`)
    return
  } else {
    cache[`${editionWeezeventEventId}_${tournamentWeezeventId}`] = md5
  }

  try {
    // Create array
    let tickets = {data: []}

    json.participants.forEach((participant) => {
      if (participant.id_event === parseInt(editionWeezeventEventId)) { // PATCH : il arrive que le flux retour de weezevent contient des billets sans info
        let user = {}
        participant.answers.forEach((answer) => {
          if (answer.label === "Dénomination de l'équipe") {
            user.team = answer.value
          }
          if (answer.label === 'Pseudo') {
            user.pseudo = answer.value
          }
        })
        if (participant.buyer) {
          participant.buyer.answers.forEach((answer) => {
            if (answer.label === "Dénomination de l'équipe") {
              user.team = answer.value
            }
          })
        }
        const key = participant.id_transaction
        if (groupSize > 1) { // cas d'un tournoi par équipe
          tickets.type = 'team'
          if (tickets[key] === undefined) { tickets[key] = {name: user.team, players: []} }
          tickets[key].players.push(user.pseudo)
        } else {
          if (tickets.data === undefined) { tickets.data = [] }
          tickets.type = 'solo'
          if (user.pseudo) tickets.data.push(user)
        }
      }
    })

    // Reformating team
    if (tickets.type === 'team') {
      const tmpTickets = {type: 'team', data: []}
      Object.keys(tickets).forEach((key) => {
        const team = tickets[key]

        if (team.players) {
          if (team.players.length > groupSize) {
            let tmpPlayers = []
            team.players.forEach((player) => {
              tmpPlayers.push(player)
              if (tmpPlayers.length === groupSize) {
                tmpTickets.data.push({name: team.name, players: tmpPlayers})
                tmpPlayers = []
              }
            })
            tmpTickets.data.push({name: team.name, players: tmpPlayers})
          } else {
            tmpTickets.data.push(team)
          }
        }
      })
      tickets = tmpTickets
    }

    // Writing data into DB
    const graphqlQuery = {
      query: `
      mutation ($input: WeezeventInput) {
        createWeezevent(input: $input) {
          entity {
            entityLabel
          }
          errors
        }
      }
      `,
      variables: {input: {data: JSON.stringify(tickets), tournament: tournamentNid, token: process.env.WEEZEVENT_DRUPAL_TOKEN, count: tickets.data.length}}
    }

    const res2 = await fetch(`${process.env.BACKEND_API_URL}/graphql`, {method: 'POST', body: JSON.stringify(graphqlQuery)})
    const json2 = await res2.json()
    if (json2 && json2.data && json2.data.createWeezevent.errors.length > 0) {
      throw new Error(json2.data.createWeezevent.errors)
    }
    console.log('New data inserted into DB')
  } catch (err) {
    cache[`${editionWeezeventEventId}_${tournamentWeezeventId}`] = null
    console.log(err)
  }
}

function getGroupSize (weezeventTickets, tournamentWeezeventId) {
  let result
  weezeventTickets.events.forEach((event) => {
    if (event.categories) {
      event.categories.forEach((category) => {
        category.tickets.forEach((ticket) => {
          if (tournamentWeezeventId === ticket.id) {
            result = ticket.group_size === undefined ? 1 : ticket.group_size
          }
        })
      })
    } else {
      event.tickets.forEach((ticket) => {
        if (tournamentWeezeventId === ticket.id) {
          result = ticket.group_size === undefined ? 1 : ticket.group_size
        }
      })
    }
  })
  return result
}
