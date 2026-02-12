import React, { useState, useRef, useEffect } from 'react'
import { Upload, X, File, CheckCircle, AlertCircle, Loader } from 'lucide-react'
import '../styles/UploadTab.css'

const API_BASE_URL = 'http://localhost:8000/api/v1'

const UploadTab = () => {
  const [mode, setMode] = useState('new') // 'new' or 'existing'
  const [selectedFile, setSelectedFile] = useState(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [datasets, setDatasets] = useState([])
  const [selectedDatasetId, setSelectedDatasetId] = useState('')
  const [datasetDetails, setDatasetDetails] = useState(null)
  const [isLoadingDatasets, setIsLoadingDatasets] = useState(false)
  const [isLoadingDetails, setIsLoadingDetails] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [backendAvailable, setBackendAvailable] = useState(true)
  const [useMockMode, setUseMockMode] = useState(false)
  
  const fileInputRef = useRef(null)
  const dropZoneRef = useRef(null)
  const uploadAbortController = useRef(null)

  const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB

  // Mock datasets for UI testing
  const MOCK_DATASETS = [
    {
      id: 'innova',
      dataset_id: 'innova',
      name: 'Innova Care Health Dataset',
      row_count: 1250,
      taxonomy: 'Healthcare',
      company_context: 'Innova Care Health'
    },
    {
      id: 'lifepoint',
      dataset_id: 'lifepoint',
      name: 'LifePoint Dataset',
      row_count: 3420,
      taxonomy: 'Healthcare',
      company_context: 'LifePoint Health'
    },
    {
      id: 'sp_global',
      dataset_id: 'sp_global',
      name: 'S&P Global Dataset',
      row_count: 8900,
      taxonomy: 'Financial Services',
      company_context: 'S&P Global'
    }
  ]

  // Check backend availability on mount - but default to mock mode for UI testing
  useEffect(() => {
    // Default to mock mode for UI testing - no API calls will be made
    setBackendAvailable(false)
    setUseMockMode(true)
    
    // Optionally check backend, but don't fail if it's not available
    const checkBackend = async () => {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 1000) // 1 second timeout
        
        const response = await fetch(`${API_BASE_URL}/datasets`, { 
          method: 'GET', // Use GET instead of HEAD to avoid 405
          signal: controller.signal
        })
        
        clearTimeout(timeoutId)
        if (response.ok || response.status === 404) {
          // Backend is available
          setBackendAvailable(true)
          setUseMockMode(false)
        } else {
          // Backend returned error - stay in mock mode
          setBackendAvailable(false)
          setUseMockMode(true)
        }
      } catch (err) {
        // Backend is not available - use mock mode for UI testing
        setBackendAvailable(false)
        setUseMockMode(true)
      }
    }
    // Only check backend if explicitly needed - for now, skip it for UI testing
    // checkBackend()
  }, [])

  // Load datasets when mode is 'existing'
  useEffect(() => {
    if (mode === 'existing') {
      loadDatasets()
    }
  }, [mode])

  // Load dataset details when a dataset is selected
  useEffect(() => {
    if (mode === 'existing' && selectedDatasetId) {
      loadDatasetDetails(selectedDatasetId)
    } else {
      setDatasetDetails(null)
    }
  }, [mode, selectedDatasetId])

  const loadDatasets = async () => {
    setIsLoadingDatasets(true)
    
    // Simulate loading delay for better UX
    await new Promise(resolve => setTimeout(resolve, 500))
    
    // Always use mock mode for UI testing - skip all API calls
    if (useMockMode || !backendAvailable) {
      setDatasets(MOCK_DATASETS)
      setIsLoadingDatasets(false)
      return
    }
    
    try {
      const response = await fetch(`${API_BASE_URL}/datasets`)
      if (response.ok) {
        const data = await response.json()
        setDatasets(data.datasets || data || [])
        setBackendAvailable(true)
        setUseMockMode(false)
      } else if (response.status === 404 || response.status === 405) {
        // If endpoint doesn't exist or method not allowed, use mock data
        setDatasets(MOCK_DATASETS)
        setUseMockMode(true)
        setBackendAvailable(false)
      } else {
        setDatasets(MOCK_DATASETS) // Fallback to mock data
        setUseMockMode(true)
      }
    } catch (err) {
      // If backend is not available, use mock data for UI testing
      setDatasets(MOCK_DATASETS)
      setUseMockMode(true)
      setBackendAvailable(false)
    } finally {
      setIsLoadingDatasets(false)
    }
  }

  const loadDatasetDetails = async (datasetId) => {
    setIsLoadingDetails(true)
    setDatasetDetails(null)
    
    // Simulate loading delay for better UX
    await new Promise(resolve => setTimeout(resolve, 500))
    
    // Always use mock mode for UI testing - skip all API calls
    if (useMockMode || !backendAvailable) {
      const mockDataset = MOCK_DATASETS.find(d => d.id === datasetId || d.dataset_id === datasetId)
      if (mockDataset) {
        setDatasetDetails({
          dataset_id: mockDataset.dataset_id,
          name: mockDataset.name,
          row_count: mockDataset.row_count,
          total_rows: mockDataset.row_count,
          taxonomy: mockDataset.taxonomy,
          company_context: mockDataset.company_context
        })
      }
      setIsLoadingDetails(false)
      return
    }
    
    try {
      const response = await fetch(`${API_BASE_URL}/datasets/${datasetId}`)
      if (response.ok) {
        const data = await response.json()
        setDatasetDetails(data)
      } else if (response.status === 404 || response.status === 405) {
        // If endpoint doesn't exist or method not allowed, use mock data
        const mockDataset = MOCK_DATASETS.find(d => d.id === datasetId || d.dataset_id === datasetId)
        if (mockDataset) {
          setDatasetDetails({
            dataset_id: mockDataset.dataset_id,
            name: mockDataset.name,
            row_count: mockDataset.row_count,
            total_rows: mockDataset.row_count,
            taxonomy: mockDataset.taxonomy,
            company_context: mockDataset.company_context
          })
          setUseMockMode(true)
          setBackendAvailable(false)
        }
      } else {
        // Fallback to mock data
        const mockDataset = MOCK_DATASETS.find(d => d.id === datasetId || d.dataset_id === datasetId)
        if (mockDataset) {
          setDatasetDetails({
            dataset_id: mockDataset.dataset_id,
            name: mockDataset.name,
            row_count: mockDataset.row_count,
            total_rows: mockDataset.row_count,
            taxonomy: mockDataset.taxonomy,
            company_context: mockDataset.company_context
          })
          setUseMockMode(true)
        }
      }
    } catch (err) {
      // If backend is not available, use mock data for UI testing
      const mockDataset = MOCK_DATASETS.find(d => d.id === datasetId || d.dataset_id === datasetId)
      if (mockDataset) {
        setDatasetDetails({
          dataset_id: mockDataset.dataset_id,
          name: mockDataset.name,
          row_count: mockDataset.row_count,
          total_rows: mockDataset.row_count,
          taxonomy: mockDataset.taxonomy,
          company_context: mockDataset.company_context
        })
        setUseMockMode(true)
        setBackendAvailable(false)
      }
    } finally {
      setIsLoadingDetails(false)
    }
  }

  const validateFile = (file) => {
    setError(null)
    setSuccess(null)
    
    // Check if file exists
    if (!file) {
      setError('No file selected.')
      return false
    }
    
    // Check file type
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Invalid file type. Please upload a CSV file.')
      return false
    }

    // Check file size
    if (file.size > MAX_FILE_SIZE) {
      const maxSizeMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(0)
      setError(`File size exceeds the maximum allowed size of ${maxSizeMB}MB.`)
      return false
    }

    // Check if file is empty
    if (file.size === 0) {
      setError('The selected file is empty. Please select a valid CSV file.')
      return false
    }

    return true
  }

  const handleFileSelect = (file) => {
    if (validateFile(file)) {
      setSelectedFile(file)
      setError(null)
      setSuccess(null)
    } else {
      setSelectedFile(null)
    }
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = e.dataTransfer.files
    if (files.length > 0) {
      handleFileSelect(files[0])
    }
  }

  const handleFileInputChange = (e) => {
    const files = e.target.files
    if (files.length > 0) {
      handleFileSelect(files[0])
    }
  }

  const handleBrowseClick = () => {
    fileInputRef.current?.click()
  }

  const handleRemoveFile = () => {
    setSelectedFile(null)
    setError(null)
    setSuccess(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const validateCSV = async (file) => {
    setIsValidating(true)
    setError(null)
    
    // Simulate validation delay for better UX
    await new Promise(resolve => setTimeout(resolve, 1500))
    
    // Always use mock mode for UI testing - skip all API calls
    if (useMockMode || !backendAvailable) {
      // Mock validation - simulate CSV structure check
      // In a real scenario, this would check CSV headers, row count, etc.
      setIsValidating(false)
      return { valid: true, message: 'CSV file is valid (mock mode)' }
    }
    
    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch(`${API_BASE_URL}/datasets/validate-csv`, {
        method: 'POST',
        body: formData
      })

      // If endpoint doesn't exist (404) or method not allowed (405), skip validation
      if (response.status === 404 || response.status === 405) {
        setUseMockMode(true)
        setBackendAvailable(false)
        setIsValidating(false)
        return { valid: true, message: 'CSV file is valid (mock mode)' }
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Validation failed' }))
        throw new Error(errorData.error || errorData.message || 'CSV validation failed')
      }

      const data = await response.json()
      setIsValidating(false)
      return data
    } catch (err) {
      // If it's a network error or 405 error, use mock validation
      if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
        setUseMockMode(true)
        setBackendAvailable(false)
        setIsValidating(false)
        return { valid: true, message: 'CSV file is valid (mock mode)' }
      }
      setError(err.message || 'Failed to validate CSV file')
      setIsValidating(false)
      throw err
    }
  }

  // Simulate upload progress for mock mode
  const simulateUploadProgress = () => {
    return new Promise((resolve, reject) => {
      let progress = 0
      const interval = setInterval(() => {
        progress += Math.random() * 15 + 5 // Increment by 5-20%
        if (progress >= 100) {
          progress = 100
          clearInterval(interval)
          setTimeout(() => resolve(), 300)
        }
        setUploadProgress(progress)
      }, 200) // Update every 200ms

      // Store interval ID for cancellation
      uploadAbortController.current = { interval, reject }
    })
  }

  const handleUpload = async () => {
    if (!selectedFile) {
      setError('Please select a file to upload')
      return
    }

    if (mode === 'existing' && !selectedDatasetId) {
      setError('Please select a dataset to append to')
      return
    }

    setError(null)
    setSuccess(null)
    setIsUploading(true)
    setUploadProgress(0)

    try {
      // Validate CSV first
      await validateCSV(selectedFile)

      if (useMockMode) {
        // Simulate upload in mock mode
        await simulateUploadProgress()
        
        // Simulate occasional upload failures (10% chance) for testing retry functionality
        const shouldFail = Math.random() < 0.1
        
        if (shouldFail) {
          setError('Upload failed. Network error occurred. Please try again.')
          setIsUploading(false)
          setUploadProgress(0)
          return
        }

        // Success
        const action = mode === 'new' ? 'uploaded' : 'appended to dataset'
        setSuccess(`File ${action} successfully! (Mock mode - UI testing)`)
        setSelectedFile(null)
        setUploadProgress(0)
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
        // Reload datasets if in existing mode
        if (mode === 'existing') {
          loadDatasets()
          if (selectedDatasetId) {
            loadDatasetDetails(selectedDatasetId)
          }
        }
        setIsUploading(false)
        return
      }

      // Real backend upload - only if not in mock mode
      if (!useMockMode && backendAvailable) {
        const formData = new FormData()
        formData.append('file', selectedFile)

        let endpoint
        if (mode === 'new') {
          endpoint = `${API_BASE_URL}/datasets/upload`
        } else {
          endpoint = `${API_BASE_URL}/datasets/${selectedDatasetId}/append`
        }

        const xhr = new XMLHttpRequest()

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percentComplete = (e.loaded / e.total) * 100
            setUploadProgress(percentComplete)
          }
        })

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const response = JSON.parse(xhr.responseText)
              setSuccess(`File uploaded successfully! ${response.message || ''}`)
            } catch (e) {
              setSuccess('File uploaded successfully!')
            }
            setSelectedFile(null)
            setUploadProgress(0)
            if (fileInputRef.current) {
              fileInputRef.current.value = ''
            }
            // Reload datasets if in existing mode
            if (mode === 'existing') {
              loadDatasets()
              if (selectedDatasetId) {
                loadDatasetDetails(selectedDatasetId)
              }
            }
          } else if (xhr.status === 405) {
            // Method not allowed - switch to mock mode
            setUseMockMode(true)
            setBackendAvailable(false)
            setError('Backend API not available. Using mock mode for UI testing.')
            setIsUploading(false)
            setUploadProgress(0)
          } else {
            try {
              const errorData = JSON.parse(xhr.responseText)
              setError(errorData.error || errorData.message || 'Upload failed')
            } catch (e) {
              setError('Upload failed. Please try again.')
            }
            setIsUploading(false)
          }
        })

        xhr.addEventListener('error', () => {
          setError('Upload failed. Switching to mock mode for UI testing.')
          setBackendAvailable(false)
          setUseMockMode(true)
          setIsUploading(false)
          setUploadProgress(0)
        })

        xhr.addEventListener('abort', () => {
          setError('Upload cancelled')
          setIsUploading(false)
          setUploadProgress(0)
        })

        xhr.open('POST', endpoint)
        xhr.send(formData)
      } else {
        // Should not reach here if mock mode is working, but just in case
        setUseMockMode(true)
        setBackendAvailable(false)
        setIsUploading(false)
        setUploadProgress(0)
      }
    } catch (err) {
      setError(err.message || 'Upload failed. Please try again.')
      setIsUploading(false)
      setUploadProgress(0)
    }
  }

  const handleRetry = () => {
    setError(null)
    setSuccess(null)
    if (selectedFile) {
      handleUpload()
    } else {
      setError('No file selected. Please select a file to retry upload.')
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (uploadAbortController.current?.interval) {
        clearInterval(uploadAbortController.current.interval)
      }
    }
  }, [])

  return (
    <div className="upload-tab">
      <div className="upload-container">
        <h2 className="upload-title">Upload CSV Dataset</h2>

        {/* Backend Status Warning */}
        {!backendAvailable && (
          <div className="backend-warning">
            <AlertCircle size={16} />
            <div className="warning-content">
              <strong>Backend server not available - Using Mock Mode</strong>
              <p>UI flow is being tested with mock data. Backend API is not required for UI testing.</p>
            </div>
          </div>
        )}

        {/* Mode Selection */}
        <div className="mode-selection">
          <button
            className={`mode-button ${mode === 'new' ? 'active' : ''}`}
            onClick={() => {
              setMode('new')
              setSelectedDatasetId('')
              setDatasetDetails(null)
            }}
          >
            New Dataset
          </button>
          <button
            className={`mode-button ${mode === 'existing' ? 'active' : ''}`}
            onClick={() => setMode('existing')}
          >
            Add to Existing Dataset
          </button>
        </div>

        {/* Dataset Selection (for existing mode) */}
        {mode === 'existing' && (
          <div className="dataset-selection">
            <label className="dataset-label">Select Dataset</label>
            <select
              className="dataset-select"
              value={selectedDatasetId}
              onChange={(e) => setSelectedDatasetId(e.target.value)}
              disabled={isLoadingDatasets}
            >
              <option value="">-- Select a dataset --</option>
              {datasets.map((dataset) => (
                <option key={dataset.id || dataset.dataset_id} value={dataset.id || dataset.dataset_id}>
                  {dataset.name || dataset.dataset_id || `Dataset ${dataset.id || dataset.dataset_id}`}
                </option>
              ))}
            </select>
            {isLoadingDatasets && (
              <div className="loading-indicator">
                <Loader size={16} className="spinning" />
                <span>Loading datasets...</span>
              </div>
            )}
          </div>
        )}

        {/* Dataset Details (for existing mode) */}
        {mode === 'existing' && selectedDatasetId && (
          <div className="dataset-details">
            {isLoadingDetails ? (
              <div className="loading-indicator">
                <Loader size={16} className="spinning" />
                <span>Loading dataset details...</span>
              </div>
            ) : datasetDetails ? (
              <div className="details-content">
                <h3>Dataset Summary</h3>
                <div className="details-grid">
                  <div className="detail-item">
                    <span className="detail-label">Row Count:</span>
                    <span className="detail-value">{datasetDetails.row_count || datasetDetails.total_rows || 'N/A'}</span>
                  </div>
                  {datasetDetails.taxonomy && (
                    <div className="detail-item">
                      <span className="detail-label">Taxonomy:</span>
                      <span className="detail-value">{datasetDetails.taxonomy}</span>
                    </div>
                  )}
                  {datasetDetails.company_context && (
                    <div className="detail-item">
                      <span className="detail-label">Company Context:</span>
                      <span className="detail-value">{datasetDetails.company_context}</span>
                    </div>
                  )}
                  {datasetDetails.name && (
                    <div className="detail-item">
                      <span className="detail-label">Name:</span>
                      <span className="detail-value">{datasetDetails.name}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="error-message">
                <AlertCircle size={16} />
                <span>Failed to load dataset details</span>
              </div>
            )}
          </div>
        )}

        {/* Upload Area */}
        <div className="upload-area">
          <div
            ref={dropZoneRef}
            className={`drop-zone ${isDragging ? 'dragging' : ''} ${selectedFile ? 'has-file' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={!selectedFile ? handleBrowseClick : undefined}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileInputChange}
              style={{ display: 'none' }}
            />

            {!selectedFile ? (
              <div className="drop-zone-content">
                <Upload size={48} className="upload-icon" />
                <p className="drop-zone-text">
                  Drag and drop your CSV file here, or <span className="browse-link">browse</span>
                </p>
                <p className="drop-zone-hint">CSV files only • Max size: {(MAX_FILE_SIZE / (1024 * 1024)).toFixed(0)}MB</p>
              </div>
            ) : (
              <div className="file-selected">
                <File size={32} className="file-icon" />
                <div className="file-info">
                  <p className="file-name">{selectedFile.name}</p>
                  <p className="file-size">{(selectedFile.size / (1024 * 1024)).toFixed(2)} MB</p>
                </div>
                <button
                  className="remove-file-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRemoveFile()
                  }}
                  title="Remove file"
                >
                  <X size={20} />
                </button>
              </div>
            )}
          </div>

          {/* Upload Progress */}
          {isUploading && (
            <div className="upload-progress">
              <div className="progress-bar-container">
                <div
                  className="progress-bar"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="progress-text">{Math.round(uploadProgress)}% uploaded</p>
            </div>
          )}

          {/* Validation Status */}
          {isValidating && (
            <div className="validation-status">
              <Loader size={16} className="spinning" />
              <span>Validating CSV file...</span>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="error-message">
              <AlertCircle size={16} />
              <span>{error}</span>
              {!isUploading && !isValidating && (
                <button className="retry-btn" onClick={handleRetry}>
                  Retry
                </button>
              )}
            </div>
          )}

          {/* Success Message */}
          {success && (
            <div className="success-message">
              <CheckCircle size={16} />
              <span>{success}</span>
            </div>
          )}

          {/* Upload Button */}
          <button
            className="upload-button"
            onClick={handleUpload}
            disabled={!selectedFile || isUploading || isValidating || (mode === 'existing' && !selectedDatasetId)}
          >
            {isUploading ? (
              <>
                <Loader size={16} className="spinning" />
                Uploading...
              </>
            ) : isValidating ? (
              <>
                <Loader size={16} className="spinning" />
                Validating...
              </>
            ) : mode === 'new' ? (
              <>
                <Upload size={16} />
                Upload New Dataset
              </>
            ) : (
              <>
                <Upload size={16} />
                Append to Dataset
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

export default UploadTab
