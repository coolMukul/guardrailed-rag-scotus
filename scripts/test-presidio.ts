#!/usr/bin/env node
/**
 * Test Presidio connectivity and functionality
 *
 * Usage:
 *   npm run test:presidio
 */

import 'dotenv/config'

const PRESIDIO_URL = process.env.PRESIDIO_URL || 'http://localhost:5001'

async function main() {
  console.log(`Testing Presidio at: ${PRESIDIO_URL}\n`)

  // Test 1: Check if Presidio is reachable
  console.log('[Test 1] Checking if Presidio is reachable...')
  try {
    const healthResponse = await fetch(`${PRESIDIO_URL}/health`)
    console.log(`✓ Health check response: ${healthResponse.status} ${healthResponse.statusText}`)

    if (healthResponse.ok) {
      const health = await healthResponse.json()
      console.log(`✓ Health data:`, health)
    }
  } catch (error) {
    console.error(`✗ Health check failed:`, error instanceof Error ? error.message : String(error))
  }

  console.log()

  // Test 2: Test PII detection with a simple example
  console.log('[Test 2] Testing PII detection...')
  const testText = 'My SSN is 123-45-6789 and email is test@example.com'

  try {
    console.log(`Input: "${testText}"`)
    const response = await fetch(`${PRESIDIO_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: testText, language: 'en' }),
    })

    console.log(`Response status: ${response.status} ${response.statusText}`)

    if (!response.ok) {
      const text = await response.text()
      console.error(`✗ Error response:`, text)
      return
    }

    const data = await response.json()

    if (data.results && data.results.length > 0) {
      console.log(`✓ Found ${data.results.length} PII entities:`)
      for (const entity of data.results) {
        const value = testText.substring(entity.start, entity.end)
        console.log(`  - ${entity.entity_type}: "${value}" (score: ${entity.score.toFixed(2)})`)
      }
    } else {
      console.log(`✗ No PII entities detected (response: ${JSON.stringify(data)})`)
    }
  } catch (error) {
    console.error(`✗ PII detection failed:`, error instanceof Error ? error.message : String(error))
  }

  console.log()

  // Test 3: Test with different PII types
  console.log('[Test 3] Testing various PII types...')
  const testCases = [
    { text: 'Call me at (555) 123-4567', type: 'Phone' },
    { text: 'My card is 4532-1234-5678-9010', type: 'Credit Card' },
    { text: 'John Smith works at ACME Corp', type: 'Person/Organization' },
    { text: 'The IP is 192.168.1.1', type: 'IP Address' },
  ]

  for (const testCase of testCases) {
    try {
      const response = await fetch(`${PRESIDIO_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: testCase.text, language: 'en' }),
      })

      if (response.ok) {
        const data = await response.json()
        const count = data.results?.length || 0
        console.log(`✓ ${testCase.type}: found ${count} entities`)
        if (count > 0) {
          data.results.forEach((r: any) => {
            console.log(`    - ${r.entity_type}: "${testCase.text.substring(r.start, r.end)}"`)
          })
        }
      } else {
        console.error(`✗ ${testCase.type}: HTTP ${response.status}`)
      }
    } catch (error) {
      console.error(`✗ ${testCase.type}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.log()
  console.log('=== DIAGNOSIS ===')
  console.log('If health check passed: Presidio is running')
  console.log('If /analyze works: PII detection is functional')
  console.log('If entities found: Detection is working correctly')
  console.log()
  console.log('If tests failed:')
  console.log('1. Check if Presidio container is running: docker compose ps presidio-analyzer')
  console.log('2. Check container logs: docker compose logs presidio-analyzer')
  console.log('3. Verify PRESIDIO_URL in .env matches running container')
}

main().catch(console.error)
