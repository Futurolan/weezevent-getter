const fetch = require('node-fetch')
const crypto = require('crypto')
const moment = require('moment')

const cache = {}

init()

function init () {
  start().catch((err) => {
    console.error(err)
  }).finally(() => {
    console.log(`Wait ${process.env.WAITING_TIME || 5}min before next run`)
    setTimeout(init, (process.env.WAITING_TIME || 5) * 60 * 1000)
  })
}

async function start () {
  // Get editions from backend
  const query = `
  {
    nodeQuery(filter: {conditions: [{field: "type", value: ["edition"], operator: EQUAL}, {field: "status", value: ["1"]}]}, limit: 9999) {
      nodes:entities {
       ... on NodeEdition{
        nid
        title
        editionWeezeventEventId:fieldEditionWeezeventEventId
        endDate:fieldEditionEndDate{
            value
          }
        }
      }
    }
  }`

  const res = await fetch(`${process.env.BACKEND_API_URL}/graphql?query=${encodeURI(query)}`, { timeout: 10000 })
  const json = await res.json()

  // eslint-disable-next-line no-unused-vars
  for (const edition of json.data.nodeQuery.nodes) {
    if (moment(edition.endDate.value).isBefore()) continue
    await parseEdition(edition.nid, edition.title, edition.editionWeezeventEventId)
  }
}

async function parseEdition (editionNid, editionTitle, editionWeezeventEventId) {
  console.log(`Fetching tournaments for edition "${editionTitle}"`)

  // Get tournaments from the current edition
  const query = `
  {
    nodeQuery(filter: {conditions: [{field: "type", value: ["tournament"], operator: EQUAL}, {field: "status", value: ["1"]}, {field: "field_tournament_edition",value:["${editionNid}"]}]}, limit: 9999) {
      nodes:entities {
       ... on NodeTournament{
          nid
          title
          tournamentWeezeventIds:fieldTournamentWeezeventId
          tournamentToornamentId:fieldTournamentToornamentId
          tournamentWarlegendId:fieldTournamentWarlegendId
          teamSize:fieldWeezeventTeamSize
        }
      }
    }
  }`

  const res2 = await fetch(`${process.env.BACKEND_API_URL}/graphql?query=${encodeURI(query)}`, { timeout: 10000 })
  const json = await res2.json()

  // eslint-disable-next-line no-unused-vars
  for (const tournament of json.data.nodeQuery.nodes) {
    if (editionWeezeventEventId && tournament.tournamentWeezeventIds && tournament.tournamentWeezeventIds.length > 0) {
      console.log(`Parsing weezevent for ${tournament.title} with nid ${tournament.nid}`)
      await getWeezeventTournamentParticipants(editionWeezeventEventId, tournament.nid, tournament.title, tournament.tournamentWeezeventIds, tournament.teamSize)
    }
    if (tournament.tournamentToornamentId && tournament.tournamentWeezeventIds && tournament.tournamentWeezeventIds.length === 0) {
      console.log(`Parsing toornament for ${tournament.title} with nid ${tournament.nid} and toornamentId ${tournament.tournamentToornamentId}`)
      await getToornamentTournamentParticipants(tournament.nid, tournament.title, tournament.tournamentToornamentId)
    }
    if (tournament.tournamentWarlegendId && tournament.tournamentWeezeventIds && tournament.tournamentWeezeventIds.length === 0) {
      console.log(`Parsing warlegend for ${tournament.title} with nid ${tournament.nid}`)
    }
  }
}

async function getToornamentTournamentParticipants (tournamentNid, tournamentTitle, toornamentId) {
  let participants = []

  let pos = 0
  let total = 0
  do {
    const res = await fetch(`https://api.toornament.com/viewer/v2/tournaments/${toornamentId}/participants`, {
      headers: {
        'X-Api-Key': process.env.TOORNAMENT_API_KEY,
        Range: `participants=${pos}-${pos + 49}`
      },
      timeout: 10000
    })
    total = res.headers.get('content-range').split('/')[1]
    pos += 50
    const json = await res.json()

    participants = participants.concat(json)
  } while (pos < total)

  const md5 = crypto.createHash('md5').update(JSON.stringify(participants)).digest('hex')
  if (cache[`${toornamentId}`] === md5) {
    console.log(`Same data with hash ${md5} already processed for tournament "${tournamentTitle}" with nid ${tournamentNid} !!! Do nothing`)
    return
  } else {
    cache[`${toornamentId}`] = md5
  }

  const tickets = { data: [] }
  for (const participant of participants) {
    if (participant.lineup !== undefined) {
      if (participant.name.includes('Slot Réservé')) continue
      tickets.type = 'team'
      const team = { name: participant.name, players: [] }
      for (const player of participant.lineup) {
        team.players.push(player.name)
      }
      console.log(team)
      tickets.data.push(team)
    } else {
      tickets.type = 'solo'
      tickets.data.push({ pseudo: participant.name, team: '' })
    }
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
    variables: { input: { data: JSON.stringify(tickets), tournament: tournamentNid, token: process.env.WEEZEVENT_DRUPAL_TOKEN, count: tickets.data.length } }
  }

  const res2 = await fetch(`${process.env.BACKEND_API_URL}/graphql`, { method: 'POST', body: JSON.stringify(graphqlQuery), timeout: 10000 })

  const json2 = await res2.json()
  if (json2 && json2.data && json2.data.createWeezevent.errors.length > 0) {
    throw new Error(json2.data.createWeezevent.errors)
  }
  console.log('New data inserted into DB')
}

async function getWeezeventTournamentParticipants (editionWeezeventEventId, tournamentNid, tournamentTitle, tournamentWeezeventIds, groupSize) {
  console.log(`Fetching participants & tickets for tournament "${tournamentTitle}"`)

  if (tournamentWeezeventIds.length === 0) {
    console.log(`ERROR Field tournamentWeezeventIds is missing for tournament "${tournamentTitle}" with nid ${tournamentNid}`)
    return
  }
  if (groupSize === undefined) {
    console.log(`ERROR groupSize is undefined for tournament "${tournamentTitle}" with nid ${tournamentNid}`)
    return
  }

  const res = await fetch(`https://api.weezevent.com/participant/list?access_token=${process.env.WEEZEVENT_ACCESS_TOKEN}&api_key=${process.env.WEEZEVENT_API_KEY}&id_event[]=${editionWeezeventEventId}&id_ticket[]=${tournamentWeezeventIds.join(',')}&full=true`, { timeout: 10000 })
  const json = await res.json()

  if (json.participants === undefined) {
    console.log(`ERROR cannot found participants in "${tournamentTitle}" with nid ${tournamentNid}: ${json.error.message}`)
    return
  }
  const md5 = crypto.createHash('md5').update(JSON.stringify(json.participants)).digest('hex')
  if (cache[`${editionWeezeventEventId}_${tournamentWeezeventIds}`] === md5) {
    console.log(`Same data with hash ${md5} already processed for tournament "${tournamentTitle}" with nid ${tournamentNid} !!! Do nothing`)
    return
  } else {
    cache[`${editionWeezeventEventId}_${tournamentWeezeventIds}`] = md5
  }

  try {
    // Create array
    let tickets = { data: [] }

    json.participants.forEach((participant) => {
      if (participant.id_event === parseInt(editionWeezeventEventId)) { // PATCH : il arrive que le flux retour de weezevent contient des billets sans info
        const user = {}
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
          if (tickets[key] === undefined) { tickets[key] = { name: user.team, players: [] } }
          tickets[key].players.push(user.pseudo)
        } else {
          if (tickets.data === undefined) { tickets.data = [] }
          tickets.type = 'solo'
          if (!user.pseudo) { user.pseudo = '' }
          if (!user.team) { user.team = '' }
          tickets.data.push(user)
        }
      }
    })

    // Reformating team
    if (tickets.type === 'team') {
      const tmpTickets = { type: 'team', data: [] }
      Object.keys(tickets).forEach((key) => {
        const team = tickets[key]

        if (team.players) {
          if (team.players.length > groupSize) {
            let tmpPlayers = []
            team.players.forEach((player) => {
              tmpPlayers.push(player)
              if (tmpPlayers.length === groupSize) {
                tmpTickets.data.push({ name: team.name, players: tmpPlayers })
                tmpPlayers = []
              }
            })
            if (tmpPlayers.length !== 0) {
              tmpTickets.data.push({ name: team.name, players: tmpPlayers })
            }
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
      variables: { input: { data: JSON.stringify(tickets), tournament: tournamentNid, token: process.env.WEEZEVENT_DRUPAL_TOKEN, count: tickets.data.length } }
    }

    const res2 = await fetch(`${process.env.BACKEND_API_URL}/graphql`, { method: 'POST', body: JSON.stringify(graphqlQuery), timeout: 10000 })
    const json2 = await res2.json()
    if (json2 && json2.data && json2.data.createWeezevent.errors.length > 0) {
      throw new Error(json2.data.createWeezevent.errors)
    }
    console.log('New data inserted into DB')
  } catch (err) {
    cache[`${editionWeezeventEventId}_${tournamentWeezeventIds.join('')}`] = null
    console.log(err)
  }
}

/**
 * Old function, I keep it only for memories
 */
// function getGroupSize (weezeventTickets, tournamentWeezeventId) {
//   let result
//   weezeventTickets.events.forEach((event) => {
//     if (event.categories) {
//       event.categories.forEach((category) => {
//         category.tickets.forEach((ticket) => {
//           if (tournamentWeezeventId === ticket.id) {
//             result = ticket.group_size === undefined ? 1 : ticket.group_size
//           }
//         })
//       })
//     } else {
//       event.tickets.forEach((ticket) => {
//         if (tournamentWeezeventId === ticket.id) {
//           result = ticket.group_size === undefined ? 1 : ticket.group_size
//         }
//       })
//     }
//   })
//   return result
// }
